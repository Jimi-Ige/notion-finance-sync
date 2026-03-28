import { plaidClient } from "./plaid.js";
import {
  readCredentials,
  updateSyncState,
  type Institution,
} from "./credentials.js";
import { NOTION_DB } from "./config.js";
import {
  validateSchemas,
  getCategoryMap,
  upsertAccount,
  upsertTransaction,
  archiveTransaction,
  type AccountData,
  type TransactionData,
  type SchemaMap,
} from "./notion.js";
import { notionRequest } from "./rate-limiter.js";
import { notion } from "./notion.js";
import { applyRules } from "./rules.js";
import type {
  Transaction,
  RemovedTransaction,
  AccountBase,
} from "plaid";

// ---------------------------------------------------------------------------
// Sync engine — orchestrates the full Plaid → Rules → Notion pipeline.
//
// For each linked institution:
//   1. Pull transactions incrementally via transactionsSync (cursor-based)
//   2. Update account balances
//   3. Apply rules engine for auto-categorization
//   4. Upsert transactions into Notion (respecting Manual Override)
//   5. Archive removed transactions
//   6. Save sync cursor
//   7. Snapshot net worth
//
// Pagination resilience: preserves original cursor and restarts on
// TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION error.
//
// Reference: plaid/pattern repo for cursor management strategy
// Reference: Plaid docs for count=500 and pagination edge cases
// ---------------------------------------------------------------------------

const SYNC_COUNT = 500; // Max per page — reduces pagination errors
const MAX_PAGINATION_RETRIES = 3;

interface SyncSummary {
  institution: string;
  added: number;
  modified: number;
  removed: number;
  accounts: number;
}

// --- Main Entry Point ---

export async function runSync(): Promise<void> {
  const store = await readCredentials();

  if (store.institutions.length === 0) {
    console.log("No linked institutions. Run `npm run link` to connect a bank.");
    return;
  }

  // Discover Notion schemas once at the start
  const schemas = await validateSchemas();

  // Build category lookup map once
  console.log("\nLoading categories...");
  const categoryMap = await getCategoryMap();
  console.log(`  ${categoryMap.size} categories found`);

  const summaries: SyncSummary[] = [];

  for (const institution of store.institutions) {
    console.log(`\nSyncing: ${institution.name}...`);
    try {
      const summary = await syncInstitution(
        institution,
        schemas,
        categoryMap
      );
      summaries.push(summary);
    } catch (err: any) {
      console.error(`  Error syncing ${institution.name}: ${err.message}`);
      // Continue with other institutions
    }
  }

  // Snapshot net worth after all institutions are synced
  await snapshotNetWorth(schemas.accounts);

  // Print summary
  printSummary(summaries);
}

// --- Per-Institution Sync ---

async function syncInstitution(
  institution: Institution,
  schemas: { accounts: SchemaMap; transactions: SchemaMap; categories: SchemaMap },
  categoryMap: Map<string, string>
): Promise<SyncSummary> {
  // 1. Pull transactions with cursor resilience
  const { added, modified, removed, nextCursor } = await pullTransactions(
    institution.accessToken,
    institution.cursor
  );

  console.log(
    `  Transactions: ${added.length} added, ${modified.length} modified, ${removed.length} removed`
  );

  // 2. Update account balances and build account page ID map
  const accountPageMap = await syncAccounts(
    institution.accessToken,
    institution.name,
    schemas.accounts
  );

  // 3. Process added transactions
  for (const txn of added) {
    await processTransaction(txn, schemas.transactions, accountPageMap, categoryMap);
  }

  // 4. Process modified transactions
  for (const txn of modified) {
    await processTransaction(txn, schemas.transactions, accountPageMap, categoryMap);
  }

  // 5. Archive removed transactions
  for (const txn of removed) {
    if (txn.transaction_id) {
      const archived = await archiveTransaction(txn.transaction_id);
      if (archived) {
        console.log(`  Archived: ${txn.transaction_id}`);
      }
    }
  }

  // 6. Save new cursor and timestamp
  const timestamp = new Date().toISOString();
  await updateSyncState(institution.itemId, nextCursor, timestamp);

  return {
    institution: institution.name,
    added: added.length,
    modified: modified.length,
    removed: removed.length,
    accounts: accountPageMap.size,
  };
}

// --- Plaid Transaction Pull (with cursor resilience) ---

interface TransactionPullResult {
  added: Transaction[];
  modified: Transaction[];
  removed: RemovedTransaction[];
  nextCursor: string;
}

/**
 * Pull all transaction updates since the last cursor.
 * Implements the pagination resilience pattern from plaid/pattern:
 *   - Preserve original cursor during pagination
 *   - On TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION, restart from original
 *   - Use count=500 to minimize pagination errors
 */
async function pullTransactions(
  accessToken: string,
  savedCursor: string | null
): Promise<TransactionPullResult> {
  const added: Transaction[] = [];
  const modified: Transaction[] = [];
  const removed: RemovedTransaction[] = [];

  // Preserve original cursor for pagination restart
  const originalCursor = savedCursor ?? "";
  let cursor = originalCursor;
  let retries = 0;

  while (true) {
    try {
      const response = await plaidClient.transactionsSync({
        access_token: accessToken,
        cursor: cursor || undefined,
        count: SYNC_COUNT,
      });

      const data = response.data;
      added.push(...data.added);
      modified.push(...data.modified);
      removed.push(...data.removed);

      if (!data.has_more) {
        return { added, modified, removed, nextCursor: data.next_cursor };
      }

      cursor = data.next_cursor;
    } catch (err: any) {
      const errorCode = err?.response?.data?.error_code;

      if (
        errorCode === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" &&
        retries < MAX_PAGINATION_RETRIES
      ) {
        // Restart from original cursor per Plaid docs
        console.warn(
          `  Pagination mutation detected. Restarting from original cursor ` +
            `(retry ${retries + 1}/${MAX_PAGINATION_RETRIES})...`
        );
        cursor = originalCursor;
        added.length = 0;
        modified.length = 0;
        removed.length = 0;
        retries++;
        continue;
      }

      throw err;
    }
  }
}

// --- Account Sync ---

/**
 * Fetch current balances from Plaid and upsert into Notion Accounts DB.
 * Returns a map of Plaid Account ID → Notion Page ID for relation linking.
 */
async function syncAccounts(
  accessToken: string,
  institutionName: string,
  accountSchema: SchemaMap
): Promise<Map<string, string>> {
  const response = await plaidClient.accountsGet({
    access_token: accessToken,
  });

  const pageMap = new Map<string, string>();

  for (const acct of response.data.accounts) {
    const data: AccountData = {
      name: acct.name,
      type: mapAccountType(acct.type),
      subtype: acct.subtype?.toString() ?? null,
      balance: acct.balances.current ?? 0,
      currency: acct.balances.iso_currency_code ?? "USD",
      institution: institutionName,
      plaidAccountId: acct.account_id,
    };

    const pageId = await upsertAccount(data, accountSchema);
    pageMap.set(acct.account_id, pageId);
  }

  console.log(`  Accounts: ${pageMap.size} updated`);
  return pageMap;
}

// --- Transaction Processing ---

/**
 * Process a single transaction: apply rules, resolve relations, upsert.
 */
async function processTransaction(
  txn: Transaction,
  schema: SchemaMap,
  accountPageMap: Map<string, string>,
  categoryMap: Map<string, string>
): Promise<void> {
  const amount = Math.abs(txn.amount);
  const type: "income" | "expense" = txn.amount < 0 ? "income" : "expense";

  // Apply rules engine first
  const ruleResult = applyRules({
    merchantName: txn.merchant_name ?? txn.name,
    amount,
    type,
  });

  // Determine category: rules > Plaid category > null
  const categoryName =
    ruleResult.category ??
    txn.personal_finance_category?.primary ??
    null;

  // Look up category page ID (case-insensitive)
  const categoryPageId = categoryName
    ? categoryMap.get(categoryName.toLowerCase()) ?? null
    : null;

  // Look up account page ID
  const accountPageId = accountPageMap.get(txn.account_id) ?? null;

  const data: TransactionData = {
    description: txn.merchant_name || txn.name,
    amount,
    type,
    date: txn.date,
    merchant: txn.merchant_name ?? null,
    plaidTransactionId: txn.transaction_id,
    plaidCategory: txn.personal_finance_category?.primary ?? null,
    pending: txn.pending,
    plaidAccountId: txn.account_id,
  };

  await upsertTransaction(data, schema, accountPageId, categoryPageId);
}

// --- Net Worth Snapshot ---

/**
 * Snapshot total assets, liabilities, and net worth after sync.
 * Queries the Accounts DB for current balances grouped by type.
 *
 * Writes to Net Worth History DB if NOTION_NET_WORTH_DB is configured.
 * Otherwise, just prints to console.
 *
 * Reference: azeemba/lpaid — Plaid only provides current balances,
 * so we must snapshot after every sync to build history.
 */
async function snapshotNetWorth(accountSchema: SchemaMap): Promise<void> {
  // Query all accounts from Notion to get current balances
  let totalAssets = 0;
  let totalLiabilities = 0;
  let cursor: string | undefined = undefined;

  do {
    const response: any = await notionRequest(() =>
      notion.databases.query({
        database_id: NOTION_DB.accounts,
        start_cursor: cursor,
        page_size: 100,
      })
    );

    for (const page of response.results) {
      const props = page.properties;

      // Get balance
      const balance = props["Balance"]?.number ?? 0;

      // Get account type to classify as asset or liability
      const typeSelect = props["Type"]?.select?.name?.toLowerCase() ?? "";

      if (
        typeSelect.includes("credit") ||
        typeSelect.includes("loan")
      ) {
        totalLiabilities += Math.abs(balance);
      } else {
        totalAssets += balance;
      }
    }

    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  const netWorth = totalAssets - totalLiabilities;

  console.log(
    `\nNet Worth Snapshot:` +
      `\n  Assets:      $${totalAssets.toFixed(2)}` +
      `\n  Liabilities: $${totalLiabilities.toFixed(2)}` +
      `\n  Net Worth:   $${netWorth.toFixed(2)}`
  );

  // Write to Net Worth History DB if configured
  const netWorthDbId = process.env.NOTION_NET_WORTH_DB;
  if (netWorthDbId) {
    await notionRequest(() =>
      notion.pages.create({
        parent: { database_id: netWorthDbId },
        properties: {
          // Use a title property for the date
          Date: { date: { start: new Date().toISOString().split("T")[0] } },
          Assets: { number: totalAssets },
          Liabilities: { number: totalLiabilities },
          "Net Worth": { number: netWorth },
        },
      })
    );
    console.log("  Saved to Net Worth History DB");
  }
}

// --- Helpers ---

function mapAccountType(plaidType: string | null | undefined): string {
  switch (plaidType) {
    case "depository":
      return "Checking";
    case "credit":
      return "Credit Card";
    case "loan":
      return "Loan";
    case "investment":
      return "Investment";
    default:
      return "Other";
  }
}

function printSummary(summaries: SyncSummary[]): void {
  console.log("\n--- Sync Complete ---");
  for (const s of summaries) {
    console.log(
      `  ${s.institution}: ${s.added} added, ${s.modified} modified, ${s.removed} removed (${s.accounts} accounts)`
    );
  }
  const totalAdded = summaries.reduce((sum, s) => sum + s.added, 0);
  const totalModified = summaries.reduce((sum, s) => sum + s.modified, 0);
  const totalRemoved = summaries.reduce((sum, s) => sum + s.removed, 0);
  console.log(
    `  Total: ${totalAdded} added, ${totalModified} modified, ${totalRemoved} removed`
  );
}
