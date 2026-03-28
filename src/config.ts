import "dotenv/config";

// ---------------------------------------------------------------------------
// Environment variable reader — fails fast with a clear message if any
// required variable is missing. All personal identifiers (API keys, Notion
// DB IDs) live in .env, never in source code.
// ---------------------------------------------------------------------------

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}\n` +
        `Copy .env.example to .env and fill in your values.`
    );
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

// --- Plaid ---

export const PLAID_CLIENT_ID = required("PLAID_CLIENT_ID");
export const PLAID_SECRET = required("PLAID_SECRET");
export const PLAID_ENV = optional("PLAID_ENV", "sandbox");

// --- Notion ---

export const NOTION_TOKEN = required("NOTION_TOKEN");

export const NOTION_DB = {
  accounts: required("NOTION_ACCOUNTS_DB"),
  categories: required("NOTION_CATEGORIES_DB"),
  transactions: required("NOTION_TRANSACTIONS_DB"),
  budgets: required("NOTION_BUDGETS_DB"),
  savingsGoals: required("NOTION_SAVINGS_GOALS_DB"),
} as const;

// --- Credentials ---

/** Optional — if empty, the CLI will prompt interactively. */
export const CREDENTIAL_PASSPHRASE = process.env.CREDENTIAL_PASSPHRASE || "";

// --- Paths ---

import { homedir } from "os";
import { join } from "path";

/** Directory for encrypted credentials and sync logs. */
export const DATA_DIR = join(homedir(), ".notion-finance");
export const CREDENTIALS_PATH = join(DATA_DIR, "credentials.json");
export const LOG_PATH = join(DATA_DIR, "sync.log");

// --- Net Worth History (optional — created in Phase 3) ---

/** If set, net worth snapshots are written to this database after each sync. */
export const NOTION_NET_WORTH_DB = process.env.NOTION_NET_WORTH_DB || "";

// --- Link Server ---

export const LINK_SERVER_PORT = Number(optional("LINK_SERVER_PORT", "3000"));
export const LINK_SERVER_HOST = "127.0.0.1";
