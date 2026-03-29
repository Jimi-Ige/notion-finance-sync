import { notion, getCategoryMap } from "./notion.js";
import { NOTION_DB } from "./config.js";
import { notionRequest } from "./rate-limiter.js";

// ---------------------------------------------------------------------------
// Recurring / Subscription Detection
//
// Scans the last 90 days of transactions for recurring patterns — same
// merchant with ~monthly or ~yearly intervals (±3 days tolerance).
// Cross-references against the Budgets DB to flag untracked subscriptions.
//
// Run:         npm run detect
// Auto-add:    npm run detect -- --add
// ---------------------------------------------------------------------------

interface Transaction {
  merchant: string;
  amount: number;
  date: string;
  type: string;
}

interface RecurringPattern {
  merchant: string;
  avgAmount: number;
  frequency: "weekly" | "bi-weekly" | "monthly" | "yearly";
  occurrences: number;
  lastDate: string;
  monthlyEquivalent: number;
}

interface BudgetItem {
  name: string;
  amount: number;
  categoryId: string | null;
}

// --- Fetch Transactions ---

async function getRecentTransactions(days: number): Promise<Transaction[]> {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().split("T")[0];

  const transactions: Transaction[] = [];
  let cursor: string | undefined;

  do {
    const response: any = await notionRequest(() =>
      notion.databases.query({
        database_id: NOTION_DB.transactions,
        start_cursor: cursor,
        page_size: 100,
        filter: {
          and: [
            { property: "Date", date: { on_or_after: sinceStr } },
            { property: "Type", select: { equals: "Expense" } },
          ],
        },
      })
    );

    for (const page of response.results) {
      const props = page.properties;
      const merchant = props["Merchant"]?.rich_text?.[0]?.plain_text ?? "";
      const amount = Math.abs(props["Amount"]?.number ?? 0);
      const date = props["Date"]?.date?.start ?? "";
      const type = props["Type"]?.select?.name ?? "";

      if (merchant && date) {
        transactions.push({ merchant, amount, date, type });
      }
    }

    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  return transactions.sort((a, b) => a.date.localeCompare(b.date));
}

// --- Fetch Budget Items ---

async function getBudgetItems(): Promise<BudgetItem[]> {
  const items: BudgetItem[] = [];
  let cursor: string | undefined;

  do {
    const response: any = await notionRequest(() =>
      notion.databases.query({
        database_id: NOTION_DB.budgets,
        start_cursor: cursor,
        page_size: 100,
      })
    );

    for (const page of response.results) {
      const props = page.properties;
      const titleProp = Object.values(props).find(
        (p: any) => p.type === "title"
      ) as any;
      const name = titleProp?.title?.[0]?.plain_text ?? "";
      const amount = props["Budget Amount"]?.number ?? 0;
      const catRel = props["Category"]?.relation;
      const categoryId = catRel?.length > 0 ? catRel[0].id : null;

      if (name) items.push({ name, amount, categoryId });
    }

    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  return items;
}

// --- Pattern Detection ---

function daysBetween(a: string, b: string): number {
  return Math.abs(
    (new Date(a).getTime() - new Date(b).getTime()) / (1000 * 60 * 60 * 24)
  );
}

function detectFrequency(
  intervals: number[]
): "weekly" | "bi-weekly" | "monthly" | "yearly" | null {
  if (intervals.length === 0) return null;

  const avg = intervals.reduce((s, i) => s + i, 0) / intervals.length;
  const tolerance = 3;

  if (Math.abs(avg - 7) <= tolerance) return "weekly";
  if (Math.abs(avg - 14) <= tolerance) return "bi-weekly";
  if (avg >= 25 && avg <= 35) return "monthly";
  if (avg >= 350 && avg <= 380) return "yearly";

  return null;
}

function detectRecurringPatterns(
  transactions: Transaction[]
): RecurringPattern[] {
  // Group by normalized merchant name
  const byMerchant = new Map<string, Transaction[]>();
  for (const tx of transactions) {
    const key = tx.merchant.toLowerCase().trim();
    const group = byMerchant.get(key) ?? [];
    group.push(tx);
    byMerchant.set(key, group);
  }

  const patterns: RecurringPattern[] = [];

  for (const [, txs] of byMerchant) {
    // Need at least 2 transactions to detect a pattern
    if (txs.length < 2) continue;

    // Sort by date
    txs.sort((a, b) => a.date.localeCompare(b.date));

    // Compute intervals between consecutive transactions
    const intervals: number[] = [];
    for (let i = 1; i < txs.length; i++) {
      intervals.push(daysBetween(txs[i].date, txs[i - 1].date));
    }

    const frequency = detectFrequency(intervals);
    if (!frequency) continue;

    // Check amount consistency (within 20% of median)
    const amounts = txs.map((t) => t.amount).sort((a, b) => a - b);
    const median = amounts[Math.floor(amounts.length / 2)];
    const consistent = amounts.every(
      (a) => Math.abs(a - median) / median <= 0.2
    );
    if (!consistent) continue;

    const avgAmount = amounts.reduce((s, a) => s + a, 0) / amounts.length;
    let monthlyEquivalent = avgAmount;
    if (frequency === "yearly") monthlyEquivalent = avgAmount / 12;
    else if (frequency === "weekly") monthlyEquivalent = avgAmount * 4.33;
    else if (frequency === "bi-weekly") monthlyEquivalent = avgAmount * 2.17;

    patterns.push({
      merchant: txs[0].merchant,
      avgAmount: Math.round(avgAmount * 100) / 100,
      frequency,
      occurrences: txs.length,
      lastDate: txs[txs.length - 1].date,
      monthlyEquivalent: Math.round(monthlyEquivalent * 100) / 100,
    });
  }

  return patterns.sort((a, b) => b.monthlyEquivalent - a.monthlyEquivalent);
}

// --- Cross-reference with Budgets ---

function findUntracked(
  patterns: RecurringPattern[],
  budgets: BudgetItem[]
): RecurringPattern[] {
  const budgetNames = new Set(
    budgets.map((b) => b.name.toLowerCase().trim())
  );

  return patterns.filter((p) => {
    const merchantLower = p.merchant.toLowerCase().trim();
    // Check if any budget name is a substring of the merchant or vice versa
    for (const budgetName of budgetNames) {
      if (
        merchantLower.includes(budgetName) ||
        budgetName.includes(merchantLower)
      ) {
        return false; // tracked
      }
    }
    return true; // untracked
  });
}

// --- Auto-add to Budgets DB ---

async function addToBudgets(
  patterns: RecurringPattern[],
  categoryMap: Map<string, string>
): Promise<number> {
  let added = 0;

  for (const pattern of patterns) {
    const properties: Record<string, any> = {
      "Budget Name": {
        title: [{ text: { content: pattern.merchant } }],
      },
      "Budget Amount": { number: pattern.avgAmount },
    };

    // Map frequency to cadence
    const cadenceMap: Record<string, string> = {
      weekly: "Weekly",
      "bi-weekly": "Bi-weekly",
      monthly: "Monthly",
      yearly: "Yearly",
    };
    properties["Cadence"] = {
      select: { name: cadenceMap[pattern.frequency] },
    };

    // Try to find a matching category (use "Subscriptions" if it exists)
    const subsCatId =
      categoryMap.get("subscriptions") ??
      categoryMap.get("subscription") ??
      categoryMap.get("recurring") ??
      null;
    if (subsCatId) {
      properties["Category"] = { relation: [{ id: subsCatId }] };
    }

    await notionRequest(() =>
      notion.pages.create({
        parent: { database_id: NOTION_DB.budgets },
        properties,
      })
    );
    added++;
  }

  return added;
}

// --- Main ---

async function main() {
  const autoAdd = process.argv.includes("--add");

  console.log("Scanning last 90 days for recurring charges...\n");

  const [transactions, budgets] = await Promise.all([
    getRecentTransactions(90),
    getBudgetItems(),
  ]);

  const patterns = detectRecurringPatterns(transactions);
  const untracked = findUntracked(patterns, budgets);
  const totalMonthly = patterns.reduce((s, p) => s + p.monthlyEquivalent, 0);

  console.log(`## Recurring Charges Detected`);
  console.log(
    `  Found ${patterns.length} recurring charges totaling $${Math.round(totalMonthly).toLocaleString()}/month.`
  );
  if (untracked.length > 0) {
    console.log(
      `  ${untracked.length} not in Budgets DB.\n`
    );
  } else {
    console.log(`  All recurring charges are tracked in Budgets DB.\n`);
  }

  // Print all detected patterns
  if (patterns.length > 0) {
    console.log(
      `  ${"Merchant".padEnd(30)} ${"Amount".padStart(10)} ${"Freq".padStart(10)} ${"Monthly".padStart(10)} ${"Status".padStart(10)}`
    );
    console.log(
      `  ${"─".repeat(30)} ${"─".repeat(10)} ${"─".repeat(10)} ${"─".repeat(10)} ${"─".repeat(10)}`
    );

    for (const p of patterns) {
      const isUntracked = untracked.includes(p);
      const status = isUntracked ? "UNTRACKED" : "tracked";
      console.log(
        `  ${p.merchant.substring(0, 30).padEnd(30)} ${("$" + p.avgAmount.toLocaleString()).padStart(10)} ${p.frequency.padStart(10)} ${("$" + p.monthlyEquivalent.toLocaleString()).padStart(10)} ${status.padStart(10)}`
      );
    }
  }

  // Auto-add if requested
  if (autoAdd && untracked.length > 0) {
    console.log(`\nAdding ${untracked.length} untracked items to Budgets DB...`);
    const categoryMap = await getCategoryMap();
    const added = await addToBudgets(untracked, categoryMap);
    console.log(`  Added ${added} budget items.`);
  } else if (!autoAdd && untracked.length > 0) {
    console.log(
      `\n  Tip: Run with --add to auto-create missing budget items.`
    );
  }

  console.log("\nRecurring detection complete.");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
