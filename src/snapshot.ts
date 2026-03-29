import { notion, getCategoryMap } from "./notion.js";
import { NOTION_DB } from "./config.js";
import { notionRequest } from "./rate-limiter.js";

// ---------------------------------------------------------------------------
// Snapshot — computes real numbers from Notion and prints a financial summary.
//
// Reads transactions for the current month, calculates totals, compares
// actual spending against budget amounts per category, and shows savings
// goals progress.
//
// Run manually:    npm run snapshot
// Run after sync:  called automatically at end of sync/import (future)
// ---------------------------------------------------------------------------

interface MonthlyTotals {
  income: number;
  expenses: number;
  net: number;
  savingsRate: string;
  month: string;
}

interface SavingsGoal {
  name: string;
  current: number;
  target: number;
  progress: string;
}

interface BudgetLine {
  name: string;
  budgeted: number;
  actual: number;
  variance: number;
  cadence: string;
  entity: string;
}

interface CategoryActual {
  categoryId: string;
  categoryName: string;
  actual: number;
}

/**
 * Query transactions for the current month and compute totals.
 * Also returns per-category actual spending.
 */
async function getMonthlyTotals(): Promise<{
  totals: MonthlyTotals;
  categoryActuals: Map<string, number>;
}> {
  const now = new Date();
  const year = now.getFullYear();
  const month = (now.getMonth() + 1).toString().padStart(2, "0");
  const startDate = `${year}-${month}-01`;
  const lastDay = new Date(year, now.getMonth() + 1, 0).getDate();
  const endDate = `${year}-${month}-${lastDay}`;

  let income = 0;
  let expenses = 0;
  const categoryActuals = new Map<string, number>(); // categoryPageId → amount
  let cursor: string | undefined = undefined;

  do {
    const response: any = await notionRequest(() =>
      notion.databases.query({
        database_id: NOTION_DB.transactions,
        start_cursor: cursor,
        page_size: 100,
        filter: {
          and: [
            { property: "Date", date: { on_or_after: startDate } },
            { property: "Date", date: { on_or_before: endDate } },
          ],
        },
      })
    );

    for (const page of response.results) {
      const amount = Math.abs(page.properties["Amount"]?.number ?? 0);
      const type = page.properties["Type"]?.select?.name?.toLowerCase();

      if (type === "income") {
        income += amount;
      } else {
        expenses += amount;
      }

      // Track per-category spending
      const catRelation = page.properties["Category"]?.relation;
      if (catRelation?.length > 0) {
        const catId = catRelation[0].id;
        categoryActuals.set(catId, (categoryActuals.get(catId) ?? 0) + amount);
      }
    }

    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  const net = income - expenses;
  const savingsRate = income > 0 ? Math.round((net / income) * 100) : 0;
  const monthName = now.toLocaleString("en-US", { month: "long", year: "numeric" });

  return {
    totals: {
      income: Math.round(income),
      expenses: Math.round(expenses),
      net: Math.round(net),
      savingsRate: `${savingsRate}%`,
      month: monthName,
    },
    categoryActuals,
  };
}

/**
 * Read budget items from the Budgets DB and compute budget vs actual.
 */
async function getBudgetComparison(
  categoryActuals: Map<string, number>
): Promise<BudgetLine[]> {
  // Build reverse map: category page ID → category name
  const catIdToName = new Map<string, string>();
  let catCursor: string | undefined = undefined;
  do {
    const response: any = await notionRequest(() =>
      notion.databases.query({
        database_id: NOTION_DB.categories,
        start_cursor: catCursor,
        page_size: 100,
      })
    );
    for (const page of response.results) {
      const titleProp = Object.values(page.properties).find(
        (p: any) => p.type === "title"
      ) as any;
      const name = titleProp?.title?.[0]?.plain_text ?? "Untitled";
      catIdToName.set(page.id, name);
    }
    catCursor = response.has_more ? response.next_cursor : undefined;
  } while (catCursor);

  // Aggregate budgeted amounts per category (sum all budget items linked to each category)
  const categoryBudgets = new Map<string, { budgeted: number; names: string[]; cadence: string; entity: string }>();
  let cursor: string | undefined = undefined;

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
      const name = titleProp?.title?.[0]?.plain_text ?? "Untitled";

      const amount = props["Budget Amount"]?.number ?? 0;
      const cadence = props["Cadence"]?.select?.name ?? "Monthly";
      const entity = props["Entity"]?.select?.name ?? "Personal";

      // Get monthly equivalent
      let monthlyAmount = amount;
      if (cadence === "Yearly") monthlyAmount = amount / 12;
      else if (cadence === "Weekly") monthlyAmount = amount * 4.33;
      else if (cadence === "Bi-weekly") monthlyAmount = amount * 2.17;

      // Get linked category
      const catRelation = props["Category"]?.relation;
      if (catRelation?.length > 0) {
        const catId = catRelation[0].id;
        const existing = categoryBudgets.get(catId);
        if (existing) {
          existing.budgeted += monthlyAmount;
          existing.names.push(name);
        } else {
          categoryBudgets.set(catId, {
            budgeted: monthlyAmount,
            names: [name],
            cadence,
            entity,
          });
        }
      }
    }

    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  // Build budget lines by category
  const lines: BudgetLine[] = [];
  for (const [catId, budget] of categoryBudgets) {
    const catName = catIdToName.get(catId) ?? "Unknown";
    const actual = categoryActuals.get(catId) ?? 0;
    lines.push({
      name: catName,
      budgeted: Math.round(budget.budgeted),
      actual: Math.round(actual),
      variance: Math.round(budget.budgeted - actual),
      cadence: budget.cadence,
      entity: budget.entity,
    });
  }

  // Sort by largest overspend first
  lines.sort((a, b) => a.variance - b.variance);
  return lines;
}

/**
 * Read savings goals from the Savings Goals DB.
 */
async function getSavingsGoals(): Promise<SavingsGoal[]> {
  const goals: SavingsGoal[] = [];
  let cursor: string | undefined = undefined;

  do {
    const response: any = await notionRequest(() =>
      notion.databases.query({
        database_id: NOTION_DB.savingsGoals,
        start_cursor: cursor,
        page_size: 100,
      })
    );

    for (const page of response.results) {
      const props = page.properties;
      const titleProp = Object.values(props).find(
        (p: any) => p.type === "title"
      ) as any;
      const name = titleProp?.title?.[0]?.plain_text ?? "Untitled";

      const current =
        props["Current Amount"]?.number ??
        props["Current"]?.number ??
        0;
      const target =
        props["Target Amount"]?.number ??
        props["Target"]?.number ??
        0;

      const pct = target > 0 ? Math.round((current / target) * 100) : 0;

      goals.push({
        name,
        current,
        target,
        progress: `${pct}% ($${current.toLocaleString()})`,
      });
    }

    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  return goals;
}

/**
 * Format a dollar amount for display.
 */
function fmtDollar(n: number): string {
  const prefix = n < 0 ? "-" : "+";
  return `${prefix}$${Math.abs(n).toLocaleString()}`;
}

async function main() {
  console.log("Calculating snapshot from Notion data...\n");

  const [{ totals, categoryActuals }, goals] = await Promise.all([
    getMonthlyTotals(),
    getSavingsGoals(),
  ]);

  // Monthly overview
  console.log(`## ${totals.month} Snapshot`);
  console.log(`  Total Income:   $${totals.income.toLocaleString()}`);
  console.log(`  Total Expenses: $${totals.expenses.toLocaleString()}`);
  console.log(`  Net Savings:    $${totals.net.toLocaleString()}`);
  console.log(`  Savings Rate:   ${totals.savingsRate}`);

  // Budget vs Actual
  const budgetLines = await getBudgetComparison(categoryActuals);
  if (budgetLines.length > 0) {
    console.log(`\n## Budget vs Actual (Monthly)`);
    console.log(`  ${"Category".padEnd(25)} ${"Budget".padStart(10)} ${"Actual".padStart(10)} ${"Variance".padStart(10)}`);
    console.log(`  ${"─".repeat(25)} ${"─".repeat(10)} ${"─".repeat(10)} ${"─".repeat(10)}`);

    let totalBudgeted = 0;
    let totalActual = 0;
    for (const line of budgetLines) {
      const varStr = fmtDollar(line.variance);
      const flag = line.variance < 0 ? " ⚠" : "";
      console.log(
        `  ${line.name.padEnd(25)} ${ ("$" + line.budgeted.toLocaleString()).padStart(10)} ${("$" + line.actual.toLocaleString()).padStart(10)} ${varStr.padStart(10)}${flag}`
      );
      totalBudgeted += line.budgeted;
      totalActual += line.actual;
    }

    const totalVariance = totalBudgeted - totalActual;
    console.log(`  ${"─".repeat(25)} ${"─".repeat(10)} ${"─".repeat(10)} ${"─".repeat(10)}`);
    console.log(
      `  ${"TOTAL".padEnd(25)} ${("$" + totalBudgeted.toLocaleString()).padStart(10)} ${("$" + totalActual.toLocaleString()).padStart(10)} ${fmtDollar(totalVariance).padStart(10)}`
    );
  }

  // Savings goals
  if (goals.length > 0) {
    console.log(`\n## Savings Goals`);
    for (const g of goals) {
      console.log(`  ${g.name}: ${g.progress} / $${g.target.toLocaleString()}`);
    }
  }

  console.log("\nSnapshot complete.");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
