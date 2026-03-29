import { notion } from "./notion.js";
import { NOTION_DB, NOTION_RUNWAY_HISTORY_DB } from "./config.js";
import { notionRequest } from "./rate-limiter.js";

// ---------------------------------------------------------------------------
// Cash Flow Runway + Liquidity Score
//
// Computes how many days of expenses your liquid cash can cover, plus a
// composite liquidity score (0-100). Writes results to the Runway History DB
// for time-series tracking.
//
// Run:  npm run runway
// ---------------------------------------------------------------------------

interface AccountRow {
  name: string;
  type: string;
  balance: number;
}

interface DailySpend {
  date: string;
  net: number; // negative = net outflow
}

interface UpcomingExpense {
  name: string;
  amount: number;
  dueDate: string;
}

interface RunwayResult {
  liquidCash: number;
  totalAssets: number;
  totalLiabilities: number;
  netWorth: number;
  dailyBurnRate: number;
  upcomingExpenses30d: number;
  runwayDays: number;
  projectedZeroDate: string | null;
  liquidityScore: number;
  scoreBreakdown: {
    runwayComponent: number;
    volatilityComponent: number;
    incomeStabilityComponent: number;
    budgetAdherenceComponent: number;
  };
}

// --- Data Fetching ---

async function getAccounts(): Promise<AccountRow[]> {
  const accounts: AccountRow[] = [];
  let cursor: string | undefined;

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
      const titleProp = Object.values(props).find(
        (p: any) => p.type === "title"
      ) as any;
      const name = titleProp?.title?.[0]?.plain_text ?? "Untitled";
      const type = props["Type"]?.select?.name ?? "";
      const balance = props["Balance"]?.number ?? 0;
      accounts.push({ name, type, balance });
    }

    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  return accounts;
}

/**
 * Fetch transactions from the last N days. Returns daily net spend
 * (income - expenses per day) for burn rate calculation.
 */
async function getDailySpend(days: number): Promise<DailySpend[]> {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().split("T")[0];

  const dailyMap = new Map<string, number>(); // date → net (positive = income)
  let cursor: string | undefined;

  do {
    const response: any = await notionRequest(() =>
      notion.databases.query({
        database_id: NOTION_DB.transactions,
        start_cursor: cursor,
        page_size: 100,
        filter: {
          property: "Date",
          date: { on_or_after: sinceStr },
        },
      })
    );

    for (const page of response.results) {
      const props = page.properties;
      const date = props["Date"]?.date?.start;
      if (!date) continue;

      const amount = Math.abs(props["Amount"]?.number ?? 0);
      const type = props["Type"]?.select?.name?.toLowerCase();
      const net = type === "income" ? amount : -amount;

      dailyMap.set(date, (dailyMap.get(date) ?? 0) + net);
    }

    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  return Array.from(dailyMap.entries())
    .map(([date, net]) => ({ date, net }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Compute weighted moving average daily burn rate.
 * Recent 30 days weighted 2x vs older days.
 */
function computeBurnRate(dailySpend: DailySpend[]): number {
  if (dailySpend.length === 0) return 0;

  const now = new Date();
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(now.getDate() - 30);

  let weightedSum = 0;
  let totalWeight = 0;

  for (const day of dailySpend) {
    const dayDate = new Date(day.date);
    const weight = dayDate >= thirtyDaysAgo ? 2 : 1;
    // Burn rate = spending (negative net), so we negate
    weightedSum += -day.net * weight;
    totalWeight += weight;
  }

  // Average daily burn (positive = net spending per day)
  return totalWeight > 0 ? weightedSum / totalWeight : 0;
}

/**
 * Pull upcoming expenses from Budgets DB for the next 30 days.
 * Uses Billing Date + Cadence to determine which are due.
 */
async function getUpcomingExpenses(): Promise<UpcomingExpense[]> {
  const upcoming: UpcomingExpense[] = [];
  const now = new Date();
  const currentDay = now.getDate();
  const currentMonth = now.getMonth();
  const currentYear = now.getFullYear();
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
      const name = titleProp?.title?.[0]?.plain_text ?? "Untitled";
      const amount = props["Budget Amount"]?.number ?? 0;
      const cadence = props["Cadence"]?.select?.name ?? "Monthly";
      const billingDay = props["Billing Date"]?.number ?? 1;

      if (amount <= 0) continue;

      // For monthly items: check if billing day is within the next 30 days
      if (cadence === "Monthly") {
        // Next occurrence of this billing day
        let nextDue: Date;
        if (billingDay >= currentDay) {
          nextDue = new Date(currentYear, currentMonth, billingDay);
        } else {
          nextDue = new Date(currentYear, currentMonth + 1, billingDay);
        }

        const daysUntil = Math.ceil(
          (nextDue.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
        );
        if (daysUntil <= 30) {
          upcoming.push({
            name,
            amount,
            dueDate: nextDue.toISOString().split("T")[0],
          });
        }
      } else if (cadence === "Yearly") {
        // Yearly: monthly equivalent already factored elsewhere, skip for 30-day forecast
      } else if (cadence === "Weekly") {
        // ~4 occurrences in next 30 days
        for (let i = 0; i < 4; i++) {
          const due = new Date(now);
          due.setDate(due.getDate() + i * 7);
          upcoming.push({
            name: `${name} (week ${i + 1})`,
            amount,
            dueDate: due.toISOString().split("T")[0],
          });
        }
      } else if (cadence === "Bi-weekly") {
        // ~2 occurrences in next 30 days
        for (let i = 0; i < 2; i++) {
          const due = new Date(now);
          due.setDate(due.getDate() + i * 14);
          upcoming.push({
            name: `${name} (bi-week ${i + 1})`,
            amount,
            dueDate: due.toISOString().split("T")[0],
          });
        }
      }
    }

    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  return upcoming.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

// --- Liquidity Score Components ---

/**
 * Runway component (40%): 0-100 based on runway days.
 * 180+ days = 100, 0 days = 0, linear between.
 */
function scoreRunway(runwayDays: number): number {
  return Math.min(100, Math.max(0, (runwayDays / 180) * 100));
}

/**
 * Expense volatility component (20%): lower volatility = higher score.
 * Uses coefficient of variation of daily spend.
 */
function scoreVolatility(dailySpend: DailySpend[]): number {
  const expenses = dailySpend
    .map((d) => Math.max(0, -d.net))
    .filter((e) => e > 0);
  if (expenses.length < 2) return 50; // not enough data

  const mean = expenses.reduce((s, e) => s + e, 0) / expenses.length;
  if (mean === 0) return 100;

  const variance =
    expenses.reduce((s, e) => s + (e - mean) ** 2, 0) / expenses.length;
  const cv = Math.sqrt(variance) / mean; // coefficient of variation

  // CV of 0 = perfectly stable (100), CV of 2+ = very volatile (0)
  return Math.min(100, Math.max(0, (1 - cv / 2) * 100));
}

/**
 * Income stability component (20%): checks if income arrives consistently.
 * Counts months with income out of the last 3.
 */
function scoreIncomeStability(dailySpend: DailySpend[]): number {
  const now = new Date();
  const monthsWithIncome = new Set<string>();

  for (const day of dailySpend) {
    if (day.net > 0) {
      monthsWithIncome.add(day.date.substring(0, 7)); // YYYY-MM
    }
  }

  // How many of the last 3 months had income?
  let expected = 0;
  let found = 0;
  for (let i = 0; i < 3; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    expected++;
    if (monthsWithIncome.has(key)) found++;
  }

  return expected > 0 ? (found / expected) * 100 : 50;
}

/**
 * Budget adherence component (20%): % of categories within budget.
 * Reuses snapshot logic — compares actual vs budgeted for current month.
 */
async function scoreBudgetAdherence(): Promise<number> {
  const now = new Date();
  const month = (now.getMonth() + 1).toString().padStart(2, "0");
  const startDate = `${now.getFullYear()}-${month}-01`;
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const endDate = `${now.getFullYear()}-${month}-${lastDay}`;

  // Get actual spending per category
  const categoryActuals = new Map<string, number>();
  let txCursor: string | undefined;
  do {
    const response: any = await notionRequest(() =>
      notion.databases.query({
        database_id: NOTION_DB.transactions,
        start_cursor: txCursor,
        page_size: 100,
        filter: {
          and: [
            { property: "Date", date: { on_or_after: startDate } },
            { property: "Date", date: { on_or_before: endDate } },
            { property: "Type", select: { equals: "Expense" } },
          ],
        },
      })
    );
    for (const page of response.results) {
      const amount = Math.abs(page.properties["Amount"]?.number ?? 0);
      const catRel = page.properties["Category"]?.relation;
      if (catRel?.length > 0) {
        const catId = catRel[0].id;
        categoryActuals.set(catId, (categoryActuals.get(catId) ?? 0) + amount);
      }
    }
    txCursor = response.has_more ? response.next_cursor : undefined;
  } while (txCursor);

  // Get budgeted amounts per category
  const categoryBudgets = new Map<string, number>();
  let budgetCursor: string | undefined;
  do {
    const response: any = await notionRequest(() =>
      notion.databases.query({
        database_id: NOTION_DB.budgets,
        start_cursor: budgetCursor,
        page_size: 100,
      })
    );
    for (const page of response.results) {
      const amount = page.properties["Budget Amount"]?.number ?? 0;
      const cadence = page.properties["Cadence"]?.select?.name ?? "Monthly";
      let monthly = amount;
      if (cadence === "Yearly") monthly = amount / 12;
      else if (cadence === "Weekly") monthly = amount * 4.33;
      else if (cadence === "Bi-weekly") monthly = amount * 2.17;

      const catRel = page.properties["Category"]?.relation;
      if (catRel?.length > 0) {
        const catId = catRel[0].id;
        categoryBudgets.set(catId, (categoryBudgets.get(catId) ?? 0) + monthly);
      }
    }
    budgetCursor = response.has_more ? response.next_cursor : undefined;
  } while (budgetCursor);

  // Score: % of budgeted categories that are within budget
  if (categoryBudgets.size === 0) return 50;
  let withinBudget = 0;
  for (const [catId, budgeted] of categoryBudgets) {
    const actual = categoryActuals.get(catId) ?? 0;
    if (actual <= budgeted) withinBudget++;
  }

  return (withinBudget / categoryBudgets.size) * 100;
}

// --- Write to Runway History DB ---

async function writeRunwayHistory(result: RunwayResult): Promise<void> {
  if (!NOTION_RUNWAY_HISTORY_DB) {
    console.log(
      "\n  Tip: Set NOTION_RUNWAY_HISTORY_DB in .env to track runway over time."
    );
    return;
  }

  const today = new Date().toISOString().split("T")[0];

  // Check for existing entry today (idempotent)
  const existing: any = await notionRequest(() =>
    notion.databases.query({
      database_id: NOTION_RUNWAY_HISTORY_DB,
      filter: {
        property: "Snapshot Date",
        date: { equals: today },
      },
      page_size: 1,
    })
  );

  const properties: Record<string, any> = {
    Name: {
      title: [{ text: { content: `Runway ${today}` } }],
    },
    "Snapshot Date": { date: { start: today } },
    "Liquid Cash": { number: Math.round(result.liquidCash) },
    "Daily Burn Rate": { number: Math.round(result.dailyBurnRate * 100) / 100 },
    "Runway Days": { number: Math.round(result.runwayDays) },
    "Liquidity Score": {
      number: Math.round(result.liquidityScore),
    },
    "Net Worth": { number: Math.round(result.netWorth) },
  };

  if (existing.results.length > 0) {
    await notionRequest(() =>
      notion.pages.update({
        page_id: existing.results[0].id,
        properties,
      })
    );
    console.log("  Updated today's Runway History entry.");
  } else {
    await notionRequest(() =>
      notion.pages.create({
        parent: { database_id: NOTION_RUNWAY_HISTORY_DB },
        properties,
      })
    );
    console.log("  Created new Runway History entry.");
  }
}

// --- Main ---

async function computeRunway(): Promise<RunwayResult> {
  console.log("Computing cash flow runway...\n");

  // 1. Accounts
  const accounts = await getAccounts();
  const liquidTypes = ["checking", "savings"];
  const debtTypes = ["credit card", "loan"];

  const liquidCash = accounts
    .filter((a) => liquidTypes.includes(a.type.toLowerCase()))
    .reduce((sum, a) => sum + a.balance, 0);

  const totalAssets = accounts
    .filter((a) => !debtTypes.includes(a.type.toLowerCase()))
    .reduce((sum, a) => sum + a.balance, 0);

  const totalLiabilities = accounts
    .filter((a) => debtTypes.includes(a.type.toLowerCase()))
    .reduce((sum, a) => sum + Math.abs(a.balance), 0);

  const netWorth = totalAssets - totalLiabilities;

  // 2. Daily burn rate from last 90 days
  const dailySpend = await getDailySpend(90);
  const dailyBurnRate = computeBurnRate(dailySpend);

  // 3. Upcoming known expenses (next 30 days)
  const upcoming = await getUpcomingExpenses();
  const upcomingExpenses30d = upcoming.reduce((s, e) => s + e.amount, 0);

  // 4. Runway = (liquid cash - upcoming 30d expenses) / daily burn rate
  const adjustedCash = Math.max(0, liquidCash - upcomingExpenses30d);
  const runwayDays =
    dailyBurnRate > 0 ? adjustedCash / dailyBurnRate : Infinity;

  const projectedZeroDate =
    runwayDays !== Infinity
      ? (() => {
          const d = new Date();
          d.setDate(d.getDate() + Math.round(runwayDays));
          return d.toISOString().split("T")[0];
        })()
      : null;

  // 5. Liquidity Score
  const runwayComponent = scoreRunway(runwayDays === Infinity ? 180 : runwayDays);
  const volatilityComponent = scoreVolatility(dailySpend);
  const incomeStabilityComponent = scoreIncomeStability(dailySpend);
  const budgetAdherenceComponent = await scoreBudgetAdherence();

  const liquidityScore =
    runwayComponent * 0.4 +
    volatilityComponent * 0.2 +
    incomeStabilityComponent * 0.2 +
    budgetAdherenceComponent * 0.2;

  return {
    liquidCash,
    totalAssets,
    totalLiabilities,
    netWorth,
    dailyBurnRate,
    upcomingExpenses30d,
    runwayDays: runwayDays === Infinity ? 999 : runwayDays,
    projectedZeroDate,
    liquidityScore,
    scoreBreakdown: {
      runwayComponent,
      volatilityComponent,
      incomeStabilityComponent,
      budgetAdherenceComponent,
    },
  };
}

function fmtDollar(n: number): string {
  return `$${Math.abs(Math.round(n)).toLocaleString()}`;
}

async function main() {
  const result = await computeRunway();

  console.log("## Cash Flow Runway");
  console.log(`  Liquid Cash:         ${fmtDollar(result.liquidCash)}`);
  console.log(`  Daily Burn Rate:     ${fmtDollar(result.dailyBurnRate)}/day`);
  console.log(
    `  Upcoming (30 days):  ${fmtDollar(result.upcomingExpenses30d)}`
  );
  console.log(
    `  Runway:              ${Math.round(result.runwayDays)} days`
  );
  if (result.projectedZeroDate) {
    console.log(`  Projected $0 Date:   ${result.projectedZeroDate}`);
  } else {
    console.log(`  Projected $0 Date:   N/A (income exceeds spending)`);
  }

  console.log(`\n## Net Worth`);
  console.log(`  Total Assets:        ${fmtDollar(result.totalAssets)}`);
  console.log(`  Total Liabilities:   ${fmtDollar(result.totalLiabilities)}`);
  console.log(`  Net Worth:           ${fmtDollar(result.netWorth)}`);

  console.log(`\n## Liquidity Score: ${Math.round(result.liquidityScore)}/100`);
  const b = result.scoreBreakdown;
  console.log(
    `  Runway (40%):          ${Math.round(b.runwayComponent)}/100`
  );
  console.log(
    `  Expense Volatility (20%): ${Math.round(b.volatilityComponent)}/100`
  );
  console.log(
    `  Income Stability (20%):   ${Math.round(b.incomeStabilityComponent)}/100`
  );
  console.log(
    `  Budget Adherence (20%):   ${Math.round(b.budgetAdherenceComponent)}/100`
  );

  await writeRunwayHistory(result);
  console.log("\nRunway analysis complete.");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
