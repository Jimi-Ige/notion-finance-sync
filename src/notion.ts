import { Client } from "@notionhq/client";
import { NOTION_TOKEN, NOTION_DB } from "./config.js";
import { notionRequest } from "./rate-limiter.js";

// ---------------------------------------------------------------------------
// Notion client — schema discovery, upsert logic, and query helpers.
//
// All API calls go through notionRequest() for rate limiting and retry.
// Property names are discovered at runtime via getDbSchema() so the tool
// adapts to each user's Notion workspace without hardcoding property names.
//
// Key design decisions:
//   - Query by Plaid ID for dedup (never create duplicates)
//   - Respect Manual Override checkbox (never overwrite user edits)
//   - Archive removed transactions (don't delete — user may want history)
// ---------------------------------------------------------------------------

export const notion = new Client({ auth: NOTION_TOKEN });

// --- Types ---

/** Property schema as returned by databases.retrieve() */
export interface PropertySchema {
  id: string;
  name: string;
  type: string;
}

/** Simplified property map: property name → type */
export type SchemaMap = Map<string, string>;

/** Account data shaped for Notion upsert */
export interface AccountData {
  name: string;
  type: string;
  subtype: string | null;
  balance: number;
  currency: string;
  institution: string;
  plaidAccountId: string;
}

/** Transaction data shaped for Notion upsert */
export interface TransactionData {
  description: string;
  amount: number;
  type: "income" | "expense";
  date: string;
  merchant: string | null;
  plaidTransactionId: string;
  plaidCategory: string | null;
  pending: boolean;
  plaidAccountId: string;
}

// --- Schema Discovery ---

/**
 * Fetch the property schema for a Notion database.
 * Returns a Map of property name → property type.
 */
export async function getDbSchema(databaseId: string): Promise<SchemaMap> {
  const db = await notionRequest(() =>
    notion.databases.retrieve({ database_id: databaseId })
  );

  const schema = new Map<string, string>();
  for (const [name, prop] of Object.entries((db as any).properties)) {
    schema.set(name, (prop as any).type);
  }
  return schema;
}

/**
 * Validate that required properties exist in the target databases.
 * Logs warnings for missing properties rather than failing hard —
 * users may have slightly different schemas.
 */
export async function validateSchemas(): Promise<{
  accounts: SchemaMap;
  transactions: SchemaMap;
  categories: SchemaMap;
}> {
  console.log("Discovering Notion database schemas...");

  const [accounts, transactions, categories] = await Promise.all([
    getDbSchema(NOTION_DB.accounts),
    getDbSchema(NOTION_DB.transactions),
    getDbSchema(NOTION_DB.categories),
  ]);

  // Warn about expected properties that are missing
  const checks: [string, SchemaMap, string[]][] = [
    [
      "Accounts",
      accounts,
      ["Plaid Account ID", "Balance", "Type", "Institution", "Last Synced"],
    ],
    [
      "Transactions",
      transactions,
      [
        "Plaid Transaction ID",
        "Amount",
        "Type",
        "Date",
        "Merchant",
        "Pending",
        "Manual Override",
      ],
    ],
  ];

  for (const [dbName, schema, required] of checks) {
    const missing = required.filter((p) => !schema.has(p));
    if (missing.length > 0) {
      console.warn(
        `  Warning: ${dbName} DB is missing properties: ${missing.join(", ")}\n` +
          `  The sync will skip these fields. Add them to your Notion database if needed.`
      );
    }
  }

  console.log(
    `  Accounts:     ${accounts.size} properties\n` +
      `  Transactions: ${transactions.size} properties\n` +
      `  Categories:   ${categories.size} properties`
  );

  return { accounts, transactions, categories };
}

// --- Categories ---

/**
 * Build a lookup map from category name → Notion page ID.
 * Called once per sync to avoid repeated queries.
 */
export async function getCategoryMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let cursor: string | undefined = undefined;

  do {
    const response: any = await notionRequest(() =>
      notion.databases.query({
        database_id: NOTION_DB.categories,
        start_cursor: cursor,
        page_size: 100,
      })
    );

    for (const page of response.results) {
      const titleProp = Object.values(page.properties).find(
        (p: any) => p.type === "title"
      ) as any;
      if (titleProp?.title?.[0]?.plain_text) {
        map.set(titleProp.title[0].plain_text.toLowerCase(), page.id);
      }
    }

    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  return map;
}

// --- Query Helpers ---

/**
 * Find a Notion page by a text property value. Returns the page ID or null.
 * Used for dedup: find existing account/transaction by Plaid ID.
 */
async function findPageByTextProperty(
  databaseId: string,
  propertyName: string,
  value: string
): Promise<string | null> {
  const response = await notionRequest(() =>
    notion.databases.query({
      database_id: databaseId,
      filter: {
        property: propertyName,
        rich_text: { equals: value },
      },
      page_size: 1,
    })
  );

  return response.results.length > 0 ? response.results[0].id : null;
}

// --- Accounts ---

/**
 * Create or update an account in the Accounts DB.
 * Deduplicates by "Plaid Account ID" property.
 * Returns the Notion page ID for use as a relation target.
 */
export async function upsertAccount(
  data: AccountData,
  schema: SchemaMap
): Promise<string> {
  const existingId = await findPageByTextProperty(
    NOTION_DB.accounts,
    "Plaid Account ID",
    data.plaidAccountId
  );

  // Build properties object, only including fields that exist in the schema
  const properties: Record<string, any> = {};

  // Title property — find it dynamically
  const titlePropName = findTitleProperty(schema);
  if (titlePropName) {
    properties[titlePropName] = {
      title: [{ text: { content: data.name } }],
    };
  }

  if (schema.has("Type")) {
    properties["Type"] = { select: { name: data.type } };
  }
  if (schema.has("Balance")) {
    properties["Balance"] = { number: data.balance };
  }
  if (schema.has("Currency")) {
    properties["Currency"] = { select: { name: data.currency } };
  }
  if (schema.has("Institution")) {
    properties["Institution"] = {
      rich_text: [{ text: { content: data.institution } }],
    };
  }
  if (schema.has("Plaid Account ID")) {
    properties["Plaid Account ID"] = {
      rich_text: [{ text: { content: data.plaidAccountId } }],
    };
  }
  if (schema.has("Last Synced")) {
    properties["Last Synced"] = {
      date: { start: new Date().toISOString() },
    };
  }

  if (existingId) {
    // Update existing account
    await notionRequest(() =>
      notion.pages.update({ page_id: existingId, properties })
    );
    return existingId;
  } else {
    // Create new account
    const page = await notionRequest(() =>
      notion.pages.create({
        parent: { database_id: NOTION_DB.accounts },
        properties,
      })
    );
    return page.id;
  }
}

// --- Transactions ---

/**
 * Create or update a transaction in the Transactions DB.
 * Deduplicates by "Plaid Transaction ID" property.
 * Respects the "Manual Override" checkbox — if true, skips category updates.
 */
export async function upsertTransaction(
  data: TransactionData,
  schema: SchemaMap,
  accountPageId: string | null,
  categoryPageId: string | null
): Promise<string> {
  const existingId = await findPageByTextProperty(
    NOTION_DB.transactions,
    "Plaid Transaction ID",
    data.plaidTransactionId
  );

  // Check Manual Override before updating
  let manualOverride = false;
  if (existingId) {
    manualOverride = await checkManualOverride(existingId);
  }

  const properties: Record<string, any> = {};

  // Title property
  const titlePropName = findTitleProperty(schema);
  if (titlePropName) {
    properties[titlePropName] = {
      title: [{ text: { content: data.description } }],
    };
  }

  if (schema.has("Amount")) {
    properties["Amount"] = { number: data.amount };
  }
  if (schema.has("Type")) {
    properties["Type"] = { select: { name: data.type } };
  }
  if (schema.has("Date")) {
    properties["Date"] = { date: { start: data.date } };
  }
  if (schema.has("Merchant") && data.merchant) {
    properties["Merchant"] = {
      rich_text: [{ text: { content: data.merchant } }],
    };
  }
  if (schema.has("Plaid Transaction ID")) {
    properties["Plaid Transaction ID"] = {
      rich_text: [{ text: { content: data.plaidTransactionId } }],
    };
  }
  if (schema.has("Plaid Category") && data.plaidCategory) {
    properties["Plaid Category"] = {
      rich_text: [{ text: { content: data.plaidCategory } }],
    };
  }
  if (schema.has("Pending")) {
    properties["Pending"] = { checkbox: data.pending };
  }

  // Only set category relation if not manually overridden
  if (!manualOverride && categoryPageId && schema.has("Category")) {
    properties["Category"] = {
      relation: [{ id: categoryPageId }],
    };
  }

  // Account relation
  if (accountPageId && schema.has("Account")) {
    properties["Account"] = {
      relation: [{ id: accountPageId }],
    };
  }

  // Cleared defaults to false on creation
  if (!existingId && schema.has("Cleared")) {
    properties["Cleared"] = { checkbox: false };
  }

  if (existingId) {
    await notionRequest(() =>
      notion.pages.update({ page_id: existingId, properties })
    );
    return existingId;
  } else {
    const page = await notionRequest(() =>
      notion.pages.create({
        parent: { database_id: NOTION_DB.transactions },
        properties,
      })
    );
    return page.id;
  }
}

/**
 * Archive a removed transaction by Plaid Transaction ID.
 */
export async function archiveTransaction(
  plaidTransactionId: string
): Promise<boolean> {
  const pageId = await findPageByTextProperty(
    NOTION_DB.transactions,
    "Plaid Transaction ID",
    plaidTransactionId
  );

  if (!pageId) return false;

  await notionRequest(() =>
    notion.pages.update({ page_id: pageId, archived: true })
  );
  return true;
}

// --- Helpers ---

/**
 * Check if a transaction page has Manual Override set to true.
 */
async function checkManualOverride(pageId: string): Promise<boolean> {
  const page: any = await notionRequest(() =>
    notion.pages.retrieve({ page_id: pageId })
  );

  const override = page.properties?.["Manual Override"];
  return override?.type === "checkbox" && override.checkbox === true;
}

/**
 * Find the title property name in a schema (every Notion DB has exactly one).
 */
function findTitleProperty(schema: SchemaMap): string | null {
  for (const [name, type] of schema) {
    if (type === "title") return name;
  }
  return null;
}
