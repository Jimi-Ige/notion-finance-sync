import { notion } from "./notion.js";
import { NOTION_DB } from "./config.js";
import { notionRequest } from "./rate-limiter.js";

// ---------------------------------------------------------------------------
// Debt Optimization — compares Avalanche vs Snowball payoff strategies.
//
// Reads debt accounts (Credit Card + Loan) with their balances, interest
// rates, and minimum payments. Simulates both strategies month by month
// to show total interest paid and months to payoff.
//
// Requires: Balance, Interest Rate, and Minimum Payment populated on
// debt accounts in the Accounts DB.
//
// Run:  npm run debt
// ---------------------------------------------------------------------------

interface DebtAccount {
  name: string;
  balance: number;
  interestRate: number; // annual, as decimal (e.g. 0.24 for 24%)
  minimumPayment: number;
}

interface PayoffResult {
  strategy: string;
  months: number;
  totalInterest: number;
  totalPaid: number;
  payoffOrder: string[];
}

// --- Fetch Debt Accounts ---

async function getDebtAccounts(): Promise<DebtAccount[]> {
  const accounts: DebtAccount[] = [];
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
      const type = props["Type"]?.select?.name ?? "";
      if (!["Credit Card", "Loan"].includes(type)) continue;

      const titleProp = Object.values(props).find(
        (p: any) => p.type === "title"
      ) as any;
      const name = titleProp?.title?.[0]?.plain_text ?? "Untitled";
      const balance = Math.abs(props["Balance"]?.number ?? 0);
      const interestRate = props["Interest Rate"]?.number ?? 0;
      const minimumPayment = props["Minimum Payment"]?.number ?? 0;

      if (balance > 0) {
        accounts.push({ name, balance, interestRate, minimumPayment });
      }
    }

    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  return accounts;
}

// --- Simulation ---

function simulatePayoff(
  accounts: DebtAccount[],
  strategy: "avalanche" | "snowball",
  extraMonthly: number
): PayoffResult {
  // Deep copy balances for simulation
  const debts = accounts.map((a) => ({
    ...a,
    remaining: a.balance,
    paidOff: false,
  }));

  // Sort by strategy
  if (strategy === "avalanche") {
    debts.sort((a, b) => b.interestRate - a.interestRate); // highest rate first
  } else {
    debts.sort((a, b) => a.remaining - b.remaining); // smallest balance first
  }

  let months = 0;
  let totalInterest = 0;
  let totalPaid = 0;
  const payoffOrder: string[] = [];
  const maxMonths = 360; // 30-year safety cap

  while (debts.some((d) => !d.paidOff) && months < maxMonths) {
    months++;
    let extraBudget = extraMonthly;

    // Apply interest first
    for (const d of debts) {
      if (d.paidOff) continue;
      const monthlyRate = d.interestRate / 12;
      const interest = d.remaining * monthlyRate;
      d.remaining += interest;
      totalInterest += interest;
    }

    // Pay minimums on all debts
    for (const d of debts) {
      if (d.paidOff) continue;
      const payment = Math.min(d.minimumPayment, d.remaining);
      d.remaining -= payment;
      totalPaid += payment;

      if (d.remaining <= 0.01) {
        d.paidOff = true;
        d.remaining = 0;
        payoffOrder.push(d.name);
        // Freed-up minimum rolls into extra budget
        extraBudget += d.minimumPayment;
      }
    }

    // Apply extra budget to target debt (first non-paid-off in sorted order)
    for (const d of debts) {
      if (d.paidOff || extraBudget <= 0) continue;
      const payment = Math.min(extraBudget, d.remaining);
      d.remaining -= payment;
      totalPaid += payment;
      extraBudget -= payment;

      if (d.remaining <= 0.01) {
        d.paidOff = true;
        d.remaining = 0;
        payoffOrder.push(d.name);
        extraBudget += d.minimumPayment;
      }
    }
  }

  return {
    strategy: strategy === "avalanche" ? "Avalanche (highest rate first)" : "Snowball (smallest balance first)",
    months,
    totalInterest: Math.round(totalInterest),
    totalPaid: Math.round(totalPaid),
    payoffOrder,
  };
}

// --- Main ---

async function main() {
  console.log("Analyzing debt payoff strategies...\n");

  const accounts = await getDebtAccounts();

  if (accounts.length === 0) {
    console.log("No debt accounts found (Credit Card or Loan with balance > 0).");
    console.log("Populate Balance, Interest Rate, and Minimum Payment on your debt accounts.");
    return;
  }

  // Show current debts
  console.log("## Current Debts");
  console.log(
    `  ${"Account".padEnd(30)} ${"Balance".padStart(12)} ${"APR".padStart(8)} ${"Min Payment".padStart(14)}`
  );
  console.log(
    `  ${"─".repeat(30)} ${"─".repeat(12)} ${"─".repeat(8)} ${"─".repeat(14)}`
  );

  let totalBalance = 0;
  let totalMinimums = 0;
  for (const a of accounts) {
    totalBalance += a.balance;
    totalMinimums += a.minimumPayment;
    console.log(
      `  ${a.name.substring(0, 30).padEnd(30)} ${("$" + a.balance.toLocaleString()).padStart(12)} ${((a.interestRate * 100).toFixed(1) + "%").padStart(8)} ${("$" + a.minimumPayment.toLocaleString()).padStart(14)}`
    );
  }
  console.log(
    `  ${"─".repeat(30)} ${"─".repeat(12)} ${"─".repeat(8)} ${"─".repeat(14)}`
  );
  console.log(
    `  ${"TOTAL".padEnd(30)} ${("$" + totalBalance.toLocaleString()).padStart(12)} ${"".padStart(8)} ${("$" + totalMinimums.toLocaleString()).padStart(14)}`
  );

  // Check for missing data
  const missingRates = accounts.filter((a) => a.interestRate === 0);
  const missingPayments = accounts.filter((a) => a.minimumPayment === 0);
  if (missingRates.length > 0) {
    console.log(
      `\n  Warning: ${missingRates.length} account(s) missing Interest Rate: ${missingRates.map((a) => a.name).join(", ")}`
    );
  }
  if (missingPayments.length > 0) {
    console.log(
      `\n  Warning: ${missingPayments.length} account(s) missing Minimum Payment: ${missingPayments.map((a) => a.name).join(", ")}`
    );
    console.log("  Payoff simulation requires Minimum Payment to be set.");
    if (missingPayments.length === accounts.length) return;
  }

  // Simulate with $0 extra and a few extra payment levels
  const extraLevels = [0, 100, 250, 500];

  for (const extra of extraLevels) {
    console.log(
      `\n## Payoff Comparison — $${extra}/month extra`
    );

    const avalanche = simulatePayoff(accounts, "avalanche", extra);
    const snowball = simulatePayoff(accounts, "snowball", extra);

    console.log(
      `  ${"Strategy".padEnd(35)} ${"Months".padStart(8)} ${"Interest".padStart(12)} ${"Total Paid".padStart(12)}`
    );
    console.log(
      `  ${"─".repeat(35)} ${"─".repeat(8)} ${"─".repeat(12)} ${"─".repeat(12)}`
    );

    for (const result of [avalanche, snowball]) {
      const years = Math.floor(result.months / 12);
      const remainingMonths = result.months % 12;
      const timeStr = years > 0
        ? `${years}y ${remainingMonths}m`
        : `${result.months}m`;
      console.log(
        `  ${result.strategy.padEnd(35)} ${timeStr.padStart(8)} ${("$" + result.totalInterest.toLocaleString()).padStart(12)} ${("$" + result.totalPaid.toLocaleString()).padStart(12)}`
      );
    }

    const savings = snowball.totalInterest - avalanche.totalInterest;
    if (savings > 0) {
      console.log(
        `  Avalanche saves $${savings.toLocaleString()} in interest over Snowball.`
      );
    }

    // Show payoff order for avalanche
    if (avalanche.payoffOrder.length > 0) {
      console.log(
        `  Avalanche payoff order: ${avalanche.payoffOrder.join(" → ")}`
      );
    }
  }

  console.log("\nDebt analysis complete.");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
