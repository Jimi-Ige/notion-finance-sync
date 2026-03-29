import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { notion } from "./notion.js";
import {
  NOTION_DB,
  NOTION_RUNWAY_HISTORY_DB,
  NOTION_WEEKLY_DIGESTS_DB,
} from "./config.js";
import { notionRequest } from "./rate-limiter.js";

// ---------------------------------------------------------------------------
// Weekly Digest — generates a financial health summary page in Notion.
//
// Checks: runway change, budget adherence, spending spikes, upcoming large
// recurring expenses, untracked recurring charges, income gaps, debt progress.
//
// Run manually:   npm run digest
// Schedule:       Task Scheduler every Sunday alongside daily sync
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

interface AlertConfig {
  budgetWarningThreshold: number;
  spendingSpikeMultiplier: number;
  spendingSpikeWindowWeeks: number;
  lowRunwayDays: number;
  criticalRunwayDays: number;
}

function loadAlertConfig(): AlertConfig {
  const defaults: AlertConfig = {
    budgetWarningThreshold: 0.8,
    spendingSpikeMultiplier: 1.5,
    spendingSpikeWindowWeeks: 4,
    lowRunwayDays: 30,
    criticalRunwayDays: 14,
  };

  try {
    const raw = readFileSync(join(__dirname, "..", "alerts.json"), "utf-8");
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return defaults;
  }
}

// --- Data helpers ---

interface RunwaySnapshot {
  date: string;
  runwayDays: number;
  liquidityScore: number;
  liquidCash: number;
  netWorth: number;
}

async function getRecentRunwaySnapshots(
  limit: number
): Promise<RunwaySnapshot[]> {
  if (!NOTION_RUNWAY_HISTORY_DB) return [];

  const response: any = await notionRequest(() =>
    notion.databases.query({
      database_id: NOTION_RUNWAY_HISTORY_DB,
      sorts: [{ property: "Snapshot Date", direction: "descending" }],
      page_size: limit,
    })
  );

  return response.results.map((page: any) => ({
    date: page.properties["Snapshot Date"]?.date?.start ?? "",
    runwayDays: page.properties["Runway Days"]?.number ?? 0,
    liquidityScore: page.properties["Liquidity Score"]?.number ?? 0,
    liquidCash: page.properties["Liquid Cash"]?.number ?? 0,
    netWorth: page.properties["Net Worth"]?.number ?? 0,
  }));
}

interface CategorySpending {
  categoryName: string;
  categoryId: string;
  budgeted: number;
  actual: number;
  pctUsed: number;
}

async function getBudgetStatus(): Promise<CategorySpending[]> {
  const now = new Date();
  const month = (now.getMonth() + 1).toString().padStart(2, "0");
  const startDate = `${now.getFullYear()}-${month}-01`;
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const endDate = `${now.getFullYear()}-${month}-${lastDay}`;

  // Category name lookup
  const catIdToName = new Map<string, string>();
  let catCursor: string | undefined;
  do {
    const res: any = await notionRequest(() =>
      notion.databases.query({
        database_id: NOTION_DB.categories,
        start_cursor: catCursor,
        page_size: 100,
      })
    );
    for (const p of res.results) {
      const t = Object.values(p.properties).find(
        (x: any) => x.type === "title"
      ) as any;
      catIdToName.set(p.id, t?.title?.[0]?.plain_text ?? "Unknown");
    }
    catCursor = res.has_more ? res.next_cursor : undefined;
  } while (catCursor);

  // Actual spending per category
  const actuals = new Map<string, number>();
  let txCursor: string | undefined;
  do {
    const res: any = await notionRequest(() =>
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
    for (const p of res.results) {
      const amt = Math.abs(p.properties["Amount"]?.number ?? 0);
      const rel = p.properties["Category"]?.relation;
      if (rel?.length > 0) {
        actuals.set(rel[0].id, (actuals.get(rel[0].id) ?? 0) + amt);
      }
    }
    txCursor = res.has_more ? res.next_cursor : undefined;
  } while (txCursor);

  // Budgeted per category
  const budgets = new Map<string, number>();
  let bCursor: string | undefined;
  do {
    const res: any = await notionRequest(() =>
      notion.databases.query({
        database_id: NOTION_DB.budgets,
        start_cursor: bCursor,
        page_size: 100,
      })
    );
    for (const p of res.results) {
      const amt = p.properties["Budget Amount"]?.number ?? 0;
      const cadence = p.properties["Cadence"]?.select?.name ?? "Monthly";
      let monthly = amt;
      if (cadence === "Yearly") monthly = amt / 12;
      else if (cadence === "Weekly") monthly = amt * 4.33;
      else if (cadence === "Bi-weekly") monthly = amt * 2.17;

      const rel = p.properties["Category"]?.relation;
      if (rel?.length > 0) {
        budgets.set(rel[0].id, (budgets.get(rel[0].id) ?? 0) + monthly);
      }
    }
    bCursor = res.has_more ? res.next_cursor : undefined;
  } while (bCursor);

  const results: CategorySpending[] = [];
  for (const [catId, budgeted] of budgets) {
    const actual = actuals.get(catId) ?? 0;
    results.push({
      categoryName: catIdToName.get(catId) ?? "Unknown",
      categoryId: catId,
      budgeted: Math.round(budgeted),
      actual: Math.round(actual),
      pctUsed: budgeted > 0 ? actual / budgeted : 0,
    });
  }

  return results.sort((a, b) => b.pctUsed - a.pctUsed);
}

interface WeeklySpending {
  weekStart: string;
  total: number;
  byCategory: Map<string, number>;
}

async function getWeeklySpending(weeks: number): Promise<WeeklySpending[]> {
  const now = new Date();
  const since = new Date();
  since.setDate(now.getDate() - weeks * 7);
  const sinceStr = since.toISOString().split("T")[0];

  // Fetch all expense transactions in the window
  const txs: { date: string; amount: number; categoryId: string }[] = [];
  let cursor: string | undefined;
  do {
    const res: any = await notionRequest(() =>
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
    for (const p of res.results) {
      const date = p.properties["Date"]?.date?.start;
      const amount = Math.abs(p.properties["Amount"]?.number ?? 0);
      const rel = p.properties["Category"]?.relation;
      const categoryId = rel?.length > 0 ? rel[0].id : "uncategorized";
      if (date) txs.push({ date, amount, categoryId });
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  // Group into ISO weeks
  const weekMap = new Map<string, WeeklySpending>();
  for (const tx of txs) {
    const d = new Date(tx.date);
    const dayOfWeek = d.getDay();
    const monday = new Date(d);
    monday.setDate(d.getDate() - ((dayOfWeek + 6) % 7));
    const weekKey = monday.toISOString().split("T")[0];

    if (!weekMap.has(weekKey)) {
      weekMap.set(weekKey, {
        weekStart: weekKey,
        total: 0,
        byCategory: new Map(),
      });
    }
    const w = weekMap.get(weekKey)!;
    w.total += tx.amount;
    w.byCategory.set(
      tx.categoryId,
      (w.byCategory.get(tx.categoryId) ?? 0) + tx.amount
    );
  }

  return Array.from(weekMap.values()).sort((a, b) =>
    a.weekStart.localeCompare(b.weekStart)
  );
}

interface UpcomingRecurring {
  name: string;
  amount: number;
  billingDay: number;
}

async function getUpcomingLargeRecurring(
  withinDays: number
): Promise<UpcomingRecurring[]> {
  const now = new Date();
  const currentDay = now.getDate();
  const results: UpcomingRecurring[] = [];
  let cursor: string | undefined;

  do {
    const res: any = await notionRequest(() =>
      notion.databases.query({
        database_id: NOTION_DB.budgets,
        start_cursor: cursor,
        page_size: 100,
      })
    );
    for (const p of res.results) {
      const titleProp = Object.values(p.properties).find(
        (x: any) => x.type === "title"
      ) as any;
      const name = titleProp?.title?.[0]?.plain_text ?? "Untitled";
      const amount = p.properties["Budget Amount"]?.number ?? 0;
      const billingDay = p.properties["Billing Date"]?.number ?? 0;
      const cadence = p.properties["Cadence"]?.select?.name ?? "Monthly";

      if (cadence !== "Monthly" || billingDay === 0 || amount < 100) continue;

      // Check if billing day is within the next N days
      let daysUntil = billingDay - currentDay;
      if (daysUntil < 0) daysUntil += 30; // next month
      if (daysUntil <= withinDays) {
        results.push({ name, amount, billingDay });
      }
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  return results.sort((a, b) => b.amount - a.amount);
}

async function checkIncomeGaps(): Promise<string[]> {
  const now = new Date();
  const alerts: string[] = [];

  // Check if we received income this month
  const month = (now.getMonth() + 1).toString().padStart(2, "0");
  const startDate = `${now.getFullYear()}-${month}-01`;
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const endDate = `${now.getFullYear()}-${month}-${lastDay}`;

  const res: any = await notionRequest(() =>
    notion.databases.query({
      database_id: NOTION_DB.transactions,
      filter: {
        and: [
          { property: "Date", date: { on_or_after: startDate } },
          { property: "Date", date: { on_or_before: endDate } },
          { property: "Type", select: { equals: "Income" } },
        ],
      },
      page_size: 1,
    })
  );

  // If we're past the 15th and no income yet, flag it
  if (now.getDate() > 15 && res.results.length === 0) {
    alerts.push("No income recorded this month (past mid-month)");
  }

  return alerts;
}

interface DebtAccount {
  name: string;
  balance: number;
  interestRate: number;
}

async function getDebtAccounts(): Promise<DebtAccount[]> {
  const accounts: DebtAccount[] = [];
  let cursor: string | undefined;

  do {
    const res: any = await notionRequest(() =>
      notion.databases.query({
        database_id: NOTION_DB.accounts,
        start_cursor: cursor,
        page_size: 100,
      })
    );
    for (const p of res.results) {
      const type = p.properties["Type"]?.select?.name ?? "";
      if (!["Credit Card", "Loan"].includes(type)) continue;

      const titleProp = Object.values(p.properties).find(
        (x: any) => x.type === "title"
      ) as any;
      accounts.push({
        name: titleProp?.title?.[0]?.plain_text ?? "Untitled",
        balance: Math.abs(p.properties["Balance"]?.number ?? 0),
        interestRate: p.properties["Interest Rate"]?.number ?? 0,
      });
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  return accounts.sort((a, b) => b.interestRate - a.interestRate);
}

// --- Build Digest ---

async function buildDigest(): Promise<{
  runwayDays: number;
  liquidityScore: number;
  alerts: string[];
  signals: string[];
}> {
  const config = loadAlertConfig();
  const alerts: string[] = [];
  const signals: string[] = [];

  // 1. Runway change from last week
  const snapshots = await getRecentRunwaySnapshots(2);
  let runwayDays = 0;
  let liquidityScore = 0;

  if (snapshots.length >= 1) {
    runwayDays = snapshots[0].runwayDays;
    liquidityScore = snapshots[0].liquidityScore;

    if (runwayDays <= config.criticalRunwayDays) {
      alerts.push(
        `CRITICAL: Runway is ${Math.round(runwayDays)} days — below ${config.criticalRunwayDays}-day threshold`
      );
    } else if (runwayDays <= config.lowRunwayDays) {
      alerts.push(
        `LOW RUNWAY: ${Math.round(runwayDays)} days remaining (threshold: ${config.lowRunwayDays})`
      );
    }

    if (snapshots.length >= 2) {
      const delta = runwayDays - snapshots[1].runwayDays;
      const direction = delta >= 0 ? "up" : "down";
      signals.push(
        `Runway ${direction} ${Math.abs(Math.round(delta))} days from last snapshot (${Math.round(snapshots[1].runwayDays)} → ${Math.round(runwayDays)})`
      );
    }
  }

  // 2. Budget warnings (>80% spent)
  const budgetStatus = await getBudgetStatus();
  const overBudget = budgetStatus.filter(
    (c) => c.pctUsed >= config.budgetWarningThreshold
  );
  for (const cat of overBudget) {
    const pct = Math.round(cat.pctUsed * 100);
    if (cat.pctUsed >= 1) {
      alerts.push(
        `OVER BUDGET: ${cat.categoryName} at ${pct}% ($${cat.actual} / $${cat.budgeted})`
      );
    } else {
      alerts.push(
        `Approaching budget: ${cat.categoryName} at ${pct}% ($${cat.actual} / $${cat.budgeted})`
      );
    }
  }

  // 3. Spending spikes (>1.5x 4-week rolling average)
  const weeklyData = await getWeeklySpending(
    config.spendingSpikeWindowWeeks + 1
  );
  if (weeklyData.length >= 2) {
    const thisWeek = weeklyData[weeklyData.length - 1];
    const priorWeeks = weeklyData.slice(0, -1);
    const avgWeekly =
      priorWeeks.reduce((s, w) => s + w.total, 0) / priorWeeks.length;

    if (
      avgWeekly > 0 &&
      thisWeek.total > avgWeekly * config.spendingSpikeMultiplier
    ) {
      alerts.push(
        `Spending spike: $${Math.round(thisWeek.total)} this week vs $${Math.round(avgWeekly)} avg (${Math.round((thisWeek.total / avgWeekly) * 100)}%)`
      );
    }
  }

  // 4. Upcoming large recurring (next 7 days)
  const upcoming = await getUpcomingLargeRecurring(7);
  if (upcoming.length > 0) {
    const total = upcoming.reduce((s, u) => s + u.amount, 0);
    signals.push(
      `${upcoming.length} large recurring charge(s) due within 7 days totaling $${Math.round(total)}: ${upcoming.map((u) => `${u.name} ($${u.amount})`).join(", ")}`
    );
  }

  // 5. Income gaps
  const incomeAlerts = await checkIncomeGaps();
  alerts.push(...incomeAlerts);

  // 6. Debt summary
  const debts = await getDebtAccounts();
  if (debts.length > 0) {
    const totalDebt = debts.reduce((s, d) => s + d.balance, 0);
    signals.push(
      `Total debt: $${Math.round(totalDebt).toLocaleString()} across ${debts.length} account(s). Highest rate: ${debts[0].name} at ${(debts[0].interestRate * 100).toFixed(1)}%`
    );
  }

  return { runwayDays, liquidityScore, alerts, signals };
}

// --- Write to Notion ---

async function writeDigest(digest: {
  runwayDays: number;
  liquidityScore: number;
  alerts: string[];
  signals: string[];
}): Promise<void> {
  if (!NOTION_WEEKLY_DIGESTS_DB) {
    console.log(
      "\n  Set NOTION_WEEKLY_DIGESTS_DB in .env to save digests to Notion."
    );
    return;
  }

  const today = new Date().toISOString().split("T")[0];

  // Check for existing digest today (idempotent)
  const existing: any = await notionRequest(() =>
    notion.databases.query({
      database_id: NOTION_WEEKLY_DIGESTS_DB,
      filter: {
        property: "Digest Date",
        date: { equals: today },
      },
      page_size: 1,
    })
  );

  const properties: Record<string, any> = {
    Name: {
      title: [{ text: { content: `Weekly Digest ${today}` } }],
    },
    "Digest Date": { date: { start: today } },
    "Runway Days": { number: Math.round(digest.runwayDays) },
    "Liquidity Score": { number: Math.round(digest.liquidityScore) },
    Alerts: {
      rich_text: [
        {
          text: {
            content: digest.alerts.length > 0
              ? digest.alerts.map((a) => `- ${a}`).join("\n")
              : "No alerts this week.",
          },
        },
      ],
    },
    Signals: {
      rich_text: [
        {
          text: {
            content: digest.signals.length > 0
              ? digest.signals.map((s) => `- ${s}`).join("\n")
              : "No signals this week.",
          },
        },
      ],
    },
  };

  if (existing.results.length > 0) {
    await notionRequest(() =>
      notion.pages.update({
        page_id: existing.results[0].id,
        properties,
      })
    );
    console.log("  Updated today's digest entry.");
  } else {
    await notionRequest(() =>
      notion.pages.create({
        parent: { database_id: NOTION_WEEKLY_DIGESTS_DB },
        properties,
      })
    );
    console.log("  Created new digest entry.");
  }
}

// --- Main ---

async function main() {
  console.log("Generating weekly financial digest...\n");

  const digest = await buildDigest();

  // Console output
  console.log(`## Weekly Digest — ${new Date().toISOString().split("T")[0]}`);
  console.log(
    `  Runway: ${Math.round(digest.runwayDays)} days | Liquidity Score: ${Math.round(digest.liquidityScore)}/100`
  );

  if (digest.alerts.length > 0) {
    console.log(`\n## Alerts (${digest.alerts.length})`);
    for (const a of digest.alerts) {
      console.log(`  - ${a}`);
    }
  } else {
    console.log(`\n  No alerts this week.`);
  }

  if (digest.signals.length > 0) {
    console.log(`\n## Signals`);
    for (const s of digest.signals) {
      console.log(`  - ${s}`);
    }
  }

  await writeDigest(digest);
  console.log("\nDigest complete.");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
