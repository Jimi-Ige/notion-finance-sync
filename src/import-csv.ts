import { readdirSync, readFileSync } from "fs";
import { join, basename } from "path";
import { createHash } from "crypto";
import { DATA_DIR } from "./config.js";
import {
  validateSchemas,
  getCategoryMap,
  upsertAccount,
  upsertTransaction,
  type AccountData,
  type TransactionData,
  type SchemaMap,
} from "./notion.js";
import { applyRules } from "./rules.js";

// ---------------------------------------------------------------------------
// CSV Import — bridge for getting real bank data into Notion while waiting
// for Plaid production access.
//
// Reads all .csv/.CSV files from ~/.notion-finance/imports/, detects the
// Chase format (credit card vs checking/savings), and upserts into Notion
// using the same logic as the Plaid sync.
//
// Deduplication: generates a deterministic ID from account + date +
// description + amount, prefixed with "csv-" so it never collides with
// real Plaid transaction IDs.
//
// Chase CSV formats:
//   Credit:   Transaction Date, Post Date, Description, Category, Type, Amount, Memo
//   Checking: Details, Posting Date, Description, Amount, Type, Balance, Check or Slip #
// ---------------------------------------------------------------------------

const IMPORTS_DIR = join(DATA_DIR, "imports");

// --- CSV Parsing ---

interface CreditRow {
  transactionDate: string;
  postDate: string;
  description: string;
  category: string;
  type: string;
  amount: number;
}

interface CheckingRow {
  details: string;
  postingDate: string;
  description: string;
  amount: number;
  type: string;
  balance: number;
}

type ParsedRow = {
  date: string; // YYYY-MM-DD
  description: string;
  amount: number;
  merchant: string;
  category: string | null;
  txnType: "income" | "expense";
  accountLast4: string;
};

/**
 * Parse a CSV line respecting quoted fields.
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

/**
 * Parse MM/DD/YYYY to YYYY-MM-DD.
 */
function parseDate(mmddyyyy: string): string {
  const [mm, dd, yyyy] = mmddyyyy.split("/");
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

/**
 * Extract account last-4 digits from a Chase CSV filename.
 * e.g., "Chase0148_Activity..." → "0148"
 */
function extractAccountLast4(filename: string): string {
  const match = filename.match(/Chase(\d{4})/i);
  return match ? match[1] : "0000";
}

/**
 * Clean merchant name from Chase description.
 * Strips trailing IDs, transaction numbers, and common suffixes.
 */
function cleanMerchant(description: string): string {
  return (
    description
      // Remove WEB ID, PPD ID, TEL ID suffixes
      .replace(/\s+(WEB|PPD|TEL|CCD)\s+ID:\s*\S+/gi, "")
      // Remove transaction numbers
      .replace(/\s+transaction#:\s*\d+\s*\S*/gi, "")
      // Remove trailing reference codes (e.g., "XX015KV7DLA0ZC")
      .replace(/\s+[A-Z0-9]{10,}$/g, "")
      // Remove Amazon order IDs (e.g., "*B57EW6460")
      .replace(/\*[A-Z0-9]{8,}/g, "")
      // Trim extra whitespace
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Detect CSV format from header row and parse all data rows.
 */
function parseCsvFile(filePath: string, accountLast4: string): ParsedRow[] {
  const content = readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/).filter((l) => l.trim());

  if (lines.length < 2) return [];

  const header = lines[0].toLowerCase();
  const isCredit = header.startsWith("transaction date");
  const rows: ParsedRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    if (fields.length < 4) continue;

    if (isCredit) {
      // Credit card: Transaction Date, Post Date, Description, Category, Type, Amount, Memo
      const amount = parseFloat(fields[5]);
      if (isNaN(amount)) continue;

      rows.push({
        date: parseDate(fields[1]), // Use post date
        description: fields[2],
        amount,
        merchant: cleanMerchant(fields[2]),
        category: fields[3] || null,
        txnType: amount > 0 ? "income" : "expense",
        accountLast4,
      });
    } else {
      // Checking/savings: Details, Posting Date, Description, Amount, Type, Balance, Check or Slip #
      const amount = parseFloat(fields[3]);
      if (isNaN(amount)) continue;

      rows.push({
        date: parseDate(fields[1]),
        description: fields[2],
        amount,
        merchant: cleanMerchant(fields[2]),
        category: null, // Checking CSVs don't include category
        txnType: amount > 0 ? "income" : "expense",
        accountLast4,
      });
    }
  }

  return rows;
}

/**
 * Generate a deterministic dedup ID for a CSV transaction.
 * Prefixed with "csv-" to avoid collision with Plaid transaction IDs.
 */
function generateDeduplicationId(row: ParsedRow): string {
  const raw = `csv-${row.accountLast4}-${row.date}-${row.description}-${row.amount}`;
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 24);
  return `csv-${hash}`;
}

// --- Main ---

async function main() {
  // Discover CSV files
  let files: string[];
  try {
    files = readdirSync(IMPORTS_DIR).filter((f) =>
      f.toLowerCase().endsWith(".csv")
    );
  } catch {
    console.error(
      `No imports directory found at ${IMPORTS_DIR}\n` +
        `Create it and drop your Chase CSV exports there.`
    );
    process.exit(1);
  }

  if (files.length === 0) {
    console.log(`No CSV files found in ${IMPORTS_DIR}`);
    return;
  }

  console.log(`Found ${files.length} CSV file(s) in ${IMPORTS_DIR}\n`);

  // Parse all CSVs
  const allRows: ParsedRow[] = [];
  for (const file of files) {
    const last4 = extractAccountLast4(file);
    const rows = parseCsvFile(join(IMPORTS_DIR, file), last4);
    console.log(`  ${file}: ${rows.length} transactions (account ...${last4})`);
    allRows.push(...rows);
  }

  // Deduplicate by generated ID (in case date ranges overlap across files)
  const seen = new Map<string, ParsedRow>();
  for (const row of allRows) {
    const id = generateDeduplicationId(row);
    seen.set(id, row);
  }
  const uniqueRows = [...seen.entries()];
  console.log(
    `\n${allRows.length} total rows → ${uniqueRows.length} unique transactions\n`
  );

  // Validate Notion schemas
  const { accounts: acctSchema, transactions: txnSchema } =
    await validateSchemas();

  // Build category map
  const categoryMap = await getCategoryMap();
  console.log(`  Categories:   ${categoryMap.size} in Notion\n`);

  // Upsert accounts (one per unique last-4)
  const accountLast4s = [...new Set(uniqueRows.map(([, r]) => r.accountLast4))];
  const accountPageIds = new Map<string, string>();

  console.log(`Creating/updating ${accountLast4s.length} account(s)...`);
  for (const last4 of accountLast4s) {
    const accountData: AccountData = {
      name: `Chase ...${last4}`,
      type: "depository",
      subtype: null,
      balance: 0, // CSV doesn't give us a reliable current balance
      currency: "USD",
      institution: "Chase",
      plaidAccountId: `csv-chase-${last4}`,
    };

    const pageId = await upsertAccount(accountData, acctSchema);
    accountPageIds.set(last4, pageId);
    console.log(`  Chase ...${last4} → ${pageId.slice(0, 8)}...`);
  }

  // Upsert transactions
  console.log(`\nImporting ${uniqueRows.length} transactions...`);
  let created = 0;
  let updated = 0;

  for (let i = 0; i < uniqueRows.length; i++) {
    const [dedupId, row] = uniqueRows[i];

    // Apply local rules first, fall back to Chase's category
    const ruleResult = applyRules({
      merchantName: row.merchant,
      amount: Math.abs(row.amount),
      type: row.txnType,
    });
    const categoryName = ruleResult.category ?? row.category;

    // Look up category page ID
    let categoryPageId: string | null = null;
    if (categoryName) {
      categoryPageId = categoryMap.get(categoryName.toLowerCase()) ?? null;
    }

    const txnData: TransactionData = {
      description: row.description,
      amount: row.amount,
      type: row.txnType,
      date: row.date,
      merchant: row.merchant,
      plaidTransactionId: dedupId,
      plaidCategory: row.category,
      pending: false,
      plaidAccountId: `csv-chase-${row.accountLast4}`,
    };

    const accountPageId = accountPageIds.get(row.accountLast4) ?? null;
    await upsertTransaction(txnData, txnSchema, accountPageId, categoryPageId);

    // Progress indicator
    if ((i + 1) % 25 === 0 || i + 1 === uniqueRows.length) {
      console.log(
        `  ${i + 1}/${uniqueRows.length} processed`
      );
    }
  }

  console.log(`\nImport complete.`);
  console.log(`  Files processed: ${files.length}`);
  console.log(`  Transactions:    ${uniqueRows.length}`);
  console.log(`  Accounts:        ${accountLast4s.length}`);
  console.log(
    `\nWhen Plaid production access is approved, real Plaid transaction IDs`
  );
  console.log(
    `will not collide with csv-* IDs — both can coexist safely.`
  );
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
