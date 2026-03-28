import { readFileSync, existsSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Rules engine — local auto-categorization for transactions.
//
// Loads rules.json from the project root. Each rule has a "match" condition
// and a "set" action. Rules are evaluated in order; first match wins.
// If no rule matches, returns null (caller falls back to Plaid's category).
//
// Inspired by Actual Budget's rules system.
//
// Rule format:
//   { "match": { "merchant_contains": "STARBUCKS" }, "set": { "category": "Coffee" } }
//
// Supported match conditions:
//   - merchant:          exact match (case-insensitive)
//   - merchant_contains: substring match (case-insensitive)
//   - amount_gt:         amount greater than threshold
//   - amount_lt:         amount less than threshold
//   - type:              "income" or "expense"
//
// Match conditions within a single rule are AND-ed together.
// ---------------------------------------------------------------------------

interface MatchCondition {
  merchant?: string;
  merchant_contains?: string;
  amount_gt?: number;
  amount_lt?: number;
  type?: "income" | "expense";
}

interface SetAction {
  category?: string;
  flag?: boolean;
}

interface Rule {
  _comment?: string;
  match: MatchCondition;
  set: SetAction;
}

interface TransactionInput {
  merchantName: string | null;
  amount: number;
  type: "income" | "expense";
}

let cachedRules: Rule[] | null = null;

/**
 * Load rules from rules.json. Caches after first load.
 * Returns empty array if file doesn't exist.
 */
function loadRules(): Rule[] {
  if (cachedRules) return cachedRules;

  const rulesPath = join(process.cwd(), "rules.json");
  if (!existsSync(rulesPath)) {
    cachedRules = [];
    return cachedRules;
  }

  try {
    const raw = readFileSync(rulesPath, "utf8");
    cachedRules = JSON.parse(raw) as Rule[];
    return cachedRules;
  } catch (err) {
    console.warn("Warning: Could not parse rules.json, skipping rules engine.");
    cachedRules = [];
    return cachedRules;
  }
}

/**
 * Evaluate a single rule's match conditions against a transaction.
 * All conditions in a rule must match (AND logic).
 */
function evaluateMatch(match: MatchCondition, txn: TransactionInput): boolean {
  const merchant = txn.merchantName?.toLowerCase() ?? "";

  if (match.merchant !== undefined) {
    if (merchant !== match.merchant.toLowerCase()) return false;
  }

  if (match.merchant_contains !== undefined) {
    if (!merchant.includes(match.merchant_contains.toLowerCase())) return false;
  }

  if (match.amount_gt !== undefined) {
    if (txn.amount <= match.amount_gt) return false;
  }

  if (match.amount_lt !== undefined) {
    if (txn.amount >= match.amount_lt) return false;
  }

  if (match.type !== undefined) {
    if (txn.type !== match.type) return false;
  }

  return true;
}

/**
 * Apply rules to a transaction. Returns the category name if a rule matches,
 * or null if no rule matches (caller should fall back to Plaid's category).
 */
export function applyRules(txn: TransactionInput): { category: string | null; flag: boolean } {
  const rules = loadRules();

  for (const rule of rules) {
    if (evaluateMatch(rule.match, txn)) {
      return {
        category: rule.set.category ?? null,
        flag: rule.set.flag ?? false,
      };
    }
  }

  return { category: null, flag: false };
}

/** Reset the cached rules (useful if rules.json is edited mid-session). */
export function reloadRules(): void {
  cachedRules = null;
}
