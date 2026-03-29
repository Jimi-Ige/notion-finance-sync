import { notion, getCategoryMap, getDbSchema } from "./notion.js";
import { NOTION_DB } from "./config.js";
import { notionRequest } from "./rate-limiter.js";

// ---------------------------------------------------------------------------
// Budget Migration — imports recurring expense data from the old Personal
// Budget spreadsheet into the Notion-based finance tracker.
//
// What it does:
//   1. Updates existing categories with Priority Tier + Subcategory
//   2. Creates any missing categories from the spreadsheet
//   3. Migrates recurring expenses into the Budgets DB
//   4. Tags existing accounts with Entity = "Personal"
//
// Run:  npm run migrate:budget
// Safe: idempotent — skips items that already exist
// ---------------------------------------------------------------------------

// --- Category → Priority Tier + Subcategory mapping ---
// Derived from the Personal Budget.xlsx "Data" and "Expenses" sheets.

interface CategoryDef {
  name: string;
  type: "Income" | "Expense";
  priorityTier: string;
  subcategory: string;
  icon: string;
}

const CATEGORY_DEFS: CategoryDef[] = [
  // Subscriptions
  { name: "Streaming", type: "Expense", priorityTier: "1. Luxury", subcategory: "Recurring Subscriptions: Streaming", icon: "📺" },
  { name: "Media", type: "Expense", priorityTier: "1. Luxury", subcategory: "Recurring Subscriptions: Media", icon: "📰" },
  { name: "Audio", type: "Expense", priorityTier: "1. Luxury", subcategory: "Recurring Subscriptions: Audio", icon: "🎧" },
  { name: "Health & Wellness", type: "Expense", priorityTier: "2. Facilitator", subcategory: "Health and Wellness", icon: "💪" },
  { name: "Professional", type: "Expense", priorityTier: "2. Facilitator", subcategory: "Recurring Subscriptions: Professional", icon: "💼" },
  { name: "Business Services", type: "Expense", priorityTier: "4. Enabler", subcategory: "Recurring Subscriptions: Business Services", icon: "🏢" },
  { name: "Dating", type: "Expense", priorityTier: "2. Facilitator", subcategory: "Recurring Subscriptions", icon: "💝" },

  // Financial
  { name: "Credit Cards", type: "Expense", priorityTier: "5. Necessity", subcategory: "Financial: Credit Cards", icon: "💳" },
  { name: "Personal Loan", type: "Expense", priorityTier: "5. Necessity", subcategory: "Financial: Personal Loan", icon: "🏦" },
  { name: "Mortgage", type: "Expense", priorityTier: "5. Necessity", subcategory: "Financial: Mortgage", icon: "🏠" },
  { name: "HELOC", type: "Expense", priorityTier: "5. Necessity", subcategory: "Financial: HELOC", icon: "🏠" },
  { name: "HOA", type: "Expense", priorityTier: "5. Necessity", subcategory: "Financial: HOA", icon: "🏘️" },

  // Insurance
  { name: "Homeowner's Insurance", type: "Expense", priorityTier: "5. Necessity", subcategory: "Insurance: Homeowner's Insurance", icon: "🛡️" },
  { name: "Life Insurance", type: "Expense", priorityTier: "4. Enabler", subcategory: "Insurance: Life Insurance", icon: "🛡️" },
  { name: "Auto Insurance", type: "Expense", priorityTier: "5. Necessity", subcategory: "Insurance: Auto Insurance", icon: "🚗" },
  { name: "Disability Insurance", type: "Expense", priorityTier: "4. Enabler", subcategory: "Insurance: Disability Insurance", icon: "🛡️" },
  { name: "Condo Insurance", type: "Expense", priorityTier: "5. Necessity", subcategory: "Insurance: Condo Insurance", icon: "🏢" },

  // Utilities
  { name: "Electricity", type: "Expense", priorityTier: "5. Necessity", subcategory: "Utility: Electricity", icon: "⚡" },
  { name: "Water", type: "Expense", priorityTier: "5. Necessity", subcategory: "Utility: Water", icon: "💧" },
  { name: "Gas", type: "Expense", priorityTier: "5. Necessity", subcategory: "Utility: Gas", icon: "🔥" },
  { name: "Internet", type: "Expense", priorityTier: "5. Necessity", subcategory: "Internet", icon: "🌐" },
  { name: "Mobile", type: "Expense", priorityTier: "5. Necessity", subcategory: "Mobile", icon: "📱" },

  // Taxes
  { name: "Property Tax", type: "Expense", priorityTier: "5. Necessity", subcategory: "Taxes: Property Tax", icon: "🏛️" },

  // Charity
  { name: "Charity", type: "Expense", priorityTier: "4. Enabler", subcategory: "Charity", icon: "🤝" },

  // Savings / Investing
  { name: "Savings", type: "Expense", priorityTier: "3. Savings", subcategory: "Savings: Savings Account", icon: "🐷" },
  { name: "401k", type: "Expense", priorityTier: "3. Savings", subcategory: "Investing: 401k", icon: "📈" },
];

// --- Recurring expenses from the spreadsheet ---

interface RecurringExpense {
  name: string;
  entity: string;
  amount: number;
  cadence: string;
  billingDate: number; // day of month
  priorityTier: string;
  categoryName: string; // maps to a category in CATEGORY_DEFS or existing
}

const RECURRING_EXPENSES: RecurringExpense[] = [
  // Personal expenses
  { name: "Verizon Fios Internet", entity: "Personal", amount: 64.99, cadence: "Monthly", billingDate: 13, priorityTier: "5. Necessity", categoryName: "Internet" },
  { name: "Verizon Mobile", entity: "Personal", amount: 125.72, cadence: "Monthly", billingDate: 6, priorityTier: "5. Necessity", categoryName: "Mobile" },
  { name: "Mortgage", entity: "Personal", amount: 1869.11, cadence: "Monthly", billingDate: 1, priorityTier: "5. Necessity", categoryName: "Mortgage" },
  { name: "PNC HELOC Minimum Payment", entity: "Personal", amount: 266.02, cadence: "Monthly", billingDate: 2, priorityTier: "5. Necessity", categoryName: "HELOC" },
  { name: "Sofi Personal Loan", entity: "Personal", amount: 2158.22, cadence: "Monthly", billingDate: 15, priorityTier: "5. Necessity", categoryName: "Personal Loan" },
  { name: "Bank of America Monthly Payment", entity: "Personal", amount: 460.13, cadence: "Monthly", billingDate: 2, priorityTier: "5. Necessity", categoryName: "Credit Cards" },
  { name: "Chase Sapphire Minimum Payment", entity: "Personal", amount: 40, cadence: "Monthly", billingDate: 28, priorityTier: "5. Necessity", categoryName: "Credit Cards" },
  { name: "Amex Minimum Payment", entity: "Personal", amount: 0, cadence: "Monthly", billingDate: 22, priorityTier: "5. Necessity", categoryName: "Credit Cards" },
  { name: "Amazon Minimum Payment", entity: "Personal", amount: 35, cadence: "Monthly", billingDate: 2, priorityTier: "5. Necessity", categoryName: "Credit Cards" },
  { name: "Citi Minimum Payment", entity: "Personal", amount: 0, cadence: "Monthly", billingDate: 9, priorityTier: "5. Necessity", categoryName: "Credit Cards" },
  { name: "StateFarm Homeowner's Insurance", entity: "Personal", amount: 111.66, cadence: "Monthly", billingDate: 8, priorityTier: "5. Necessity", categoryName: "Homeowner's Insurance" },
  { name: "StateFarm Rental Condo Policy", entity: "Personal", amount: 53.83, cadence: "Monthly", billingDate: 16, priorityTier: "5. Necessity", categoryName: "Condo Insurance" },
  { name: "StateFarm Auto Insurance", entity: "Personal", amount: 75.95, cadence: "Monthly", billingDate: 5, priorityTier: "5. Necessity", categoryName: "Auto Insurance" },
  { name: "Northwestern Mutual Life Insurance", entity: "Personal", amount: 199.74, cadence: "Monthly", billingDate: 3, priorityTier: "4. Enabler", categoryName: "Life Insurance" },
  { name: "Northwestern Mutual Disability Insurance", entity: "Personal", amount: 40.79, cadence: "Monthly", billingDate: 3, priorityTier: "4. Enabler", categoryName: "Disability Insurance" },
  { name: "Pepco", entity: "Personal", amount: 96, cadence: "Monthly", billingDate: 15, priorityTier: "5. Necessity", categoryName: "Electricity" },
  { name: "Washington Gas (Personal)", entity: "Personal", amount: 16.69, cadence: "Monthly", billingDate: 31, priorityTier: "5. Necessity", categoryName: "Gas" },
  { name: "DC Water", entity: "Personal", amount: 51.33, cadence: "Monthly", billingDate: 22, priorityTier: "5. Necessity", categoryName: "Water" },
  { name: "Massage Envy", entity: "Personal", amount: 65, cadence: "Monthly", billingDate: 29, priorityTier: "2. Facilitator", categoryName: "Health & Wellness" },
  { name: "OneLife Fitness", entity: "Personal", amount: 29.99, cadence: "Monthly", billingDate: 25, priorityTier: "2. Facilitator", categoryName: "Health & Wellness" },
  { name: "LinkedIn Premium", entity: "Personal", amount: 29.99, cadence: "Monthly", billingDate: 15, priorityTier: "2. Facilitator", categoryName: "Professional" },
  { name: "Spotify", entity: "Personal", amount: 10.59, cadence: "Monthly", billingDate: 8, priorityTier: "1. Luxury", categoryName: "Audio" },
  { name: "Audible", entity: "Personal", amount: 8.43, cadence: "Monthly", billingDate: 16, priorityTier: "1. Luxury", categoryName: "Audio" },
  { name: "Netflix", entity: "Personal", amount: 15.49, cadence: "Monthly", billingDate: 2, priorityTier: "1. Luxury", categoryName: "Streaming" },
  { name: "Amazon - HBO Max", entity: "Personal", amount: 14.99, cadence: "Monthly", billingDate: 20, priorityTier: "1. Luxury", categoryName: "Streaming" },
  { name: "Google - YouTube TV", entity: "Personal", amount: 68.89, cadence: "Monthly", billingDate: 26, priorityTier: "1. Luxury", categoryName: "Streaming" },
  { name: "YouTube Premium", entity: "Personal", amount: 16.95, cadence: "Monthly", billingDate: 24, priorityTier: "1. Luxury", categoryName: "Media" },
  { name: "Apple - Apple News", entity: "Personal", amount: 9.99, cadence: "Monthly", billingDate: 25, priorityTier: "1. Luxury", categoryName: "Media" },
  { name: "New York Times", entity: "Personal", amount: 8, cadence: "Monthly", billingDate: 4, priorityTier: "1. Luxury", categoryName: "Media" },
  { name: "Hinge", entity: "Personal", amount: 29.99, cadence: "Monthly", billingDate: 19, priorityTier: "2. Facilitator", categoryName: "Dating" },

  // Yearly - Personal
  { name: "Amazon Prime Membership", entity: "Personal", amount: 139, cadence: "Yearly", billingDate: 14, priorityTier: "4. Enabler", categoryName: "Business Services" },
  { name: "Microsoft 365 Personal", entity: "Personal", amount: 74.19, cadence: "Yearly", billingDate: 16, priorityTier: "4. Enabler", categoryName: "Business Services" },
  { name: "Apple - Fitbod", entity: "Personal", amount: 59.99, cadence: "Yearly", billingDate: 18, priorityTier: "2. Facilitator", categoryName: "Health & Wellness" },
  { name: "Grammarly", entity: "Personal", amount: 139.95, cadence: "Yearly", billingDate: 31, priorityTier: "2. Facilitator", categoryName: "Professional" },
  { name: "Apple - Headspace", entity: "Personal", amount: 94.99, cadence: "Yearly", billingDate: 30, priorityTier: "2. Facilitator", categoryName: "Health & Wellness" },
  { name: "Apple - Seven", entity: "Personal", amount: 79.99, cadence: "Yearly", billingDate: 6, priorityTier: "2. Facilitator", categoryName: "Health & Wellness" },
  { name: "Google - Google One", entity: "Personal", amount: 19.99, cadence: "Yearly", billingDate: 25, priorityTier: "5. Necessity", categoryName: "Business Services" },
  { name: "Google - Nest Aware", entity: "Personal", amount: 60, cadence: "Yearly", billingDate: 12, priorityTier: "5. Necessity", categoryName: "Business Services" },
  { name: "Sapphire Annual Membership Fee", entity: "Personal", amount: 550, cadence: "Yearly", billingDate: 1, priorityTier: "2. Facilitator", categoryName: "Credit Cards" },
  { name: "Amex Annual Membership Fee", entity: "Personal", amount: 150, cadence: "Yearly", billingDate: 8, priorityTier: "2. Facilitator", categoryName: "Credit Cards" },
  { name: "Citi Annual Membership Fee", entity: "Personal", amount: 99, cadence: "Yearly", billingDate: 12, priorityTier: "2. Facilitator", categoryName: "Credit Cards" },
  { name: "Apple - Yoga Studio", entity: "Personal", amount: 19.99, cadence: "Yearly", billingDate: 19, priorityTier: "2. Facilitator", categoryName: "Health & Wellness" },
  { name: "Washington Post", entity: "Personal", amount: 100, cadence: "Yearly", billingDate: 15, priorityTier: "1. Luxury", categoryName: "Media" },

  // Nestly LLC expenses
  { name: "GoDaddy: pm@nestlypropertymanagement.com", entity: "Nestly LLC", amount: 71.88, cadence: "Yearly", billingDate: 6, priorityTier: "4. Enabler", categoryName: "Business Services" },
  { name: "GoDaddy: nestlypropertymanagement.com privacy", entity: "Nestly LLC", amount: 19.98, cadence: "Yearly", billingDate: 6, priorityTier: "4. Enabler", categoryName: "Business Services" },
  { name: "GoDaddy: nestlypropertymanagement.com domain", entity: "Nestly LLC", amount: 37.98, cadence: "Yearly", billingDate: 6, priorityTier: "4. Enabler", categoryName: "Business Services" },
  { name: "GoDaddy: support@nestlypropertymanagement.com", entity: "Nestly LLC", amount: 71.88, cadence: "Yearly", billingDate: 11, priorityTier: "5. Necessity", categoryName: "Business Services" },
  { name: "Pepco (Edson 4248 Apt. 1)", entity: "Nestly LLC", amount: 75.24, cadence: "Monthly", billingDate: 13, priorityTier: "5. Necessity", categoryName: "Electricity" },
  { name: "Pepco (Edson 4248 Apt. 2)", entity: "Nestly LLC", amount: 49.16, cadence: "Monthly", billingDate: 13, priorityTier: "5. Necessity", categoryName: "Electricity" },
  { name: "Pepco (57th 325 LLC)", entity: "Nestly LLC", amount: 178.07, cadence: "Monthly", billingDate: 18, priorityTier: "5. Necessity", categoryName: "Electricity" },
  { name: "Docusign", entity: "Nestly LLC", amount: 15.9, cadence: "Monthly", billingDate: 20, priorityTier: "2. Facilitator", categoryName: "Business Services" },
  { name: "Adobe", entity: "Nestly LLC", amount: 12.99, cadence: "Monthly", billingDate: 22, priorityTier: "2. Facilitator", categoryName: "Business Services" },
  { name: "Choice Home Warranty (57th 325)", entity: "Nestly LLC", amount: 49.29, cadence: "Monthly", billingDate: 22, priorityTier: "4. Enabler", categoryName: "Business Services" },
  { name: "Choice Home Warranty (Edson Apt. 1)", entity: "Nestly LLC", amount: 49.29, cadence: "Monthly", billingDate: 22, priorityTier: "4. Enabler", categoryName: "Business Services" },
  { name: "Choice Home Warranty (Edson Apt. 2)", entity: "Nestly LLC", amount: 49.29, cadence: "Monthly", billingDate: 22, priorityTier: "4. Enabler", categoryName: "Business Services" },
  { name: "DC Water (Edson 4248)", entity: "Nestly LLC", amount: 429, cadence: "Monthly", billingDate: 23, priorityTier: "5. Necessity", categoryName: "Water" },
  { name: "Washington Gas (57th 325)", entity: "Nestly LLC", amount: 16.51, cadence: "Monthly", billingDate: 29, priorityTier: "5. Necessity", categoryName: "Gas" },
  { name: "Washington Gas (Edson Apt. 1)", entity: "Nestly LLC", amount: 0, cadence: "Monthly", billingDate: 3, priorityTier: "5. Necessity", categoryName: "Gas" },
  { name: "Washington Gas (Edson Apt. 2)", entity: "Nestly LLC", amount: 39.3, cadence: "Monthly", billingDate: 3, priorityTier: "5. Necessity", categoryName: "Gas" },
  { name: "Docusign (57th 325)", entity: "Nestly LLC", amount: 120, cadence: "Yearly", billingDate: 8, priorityTier: "2. Facilitator", categoryName: "Business Services" },

  // Ft Farnsworth 2612 LLC
  { name: "John Marshall Mortgage", entity: "Ft Farnsworth 2612 LLC", amount: 686.98, cadence: "Monthly", billingDate: 1, priorityTier: "5. Necessity", categoryName: "Mortgage" },
  { name: "Fairfax Property Tax", entity: "Ft Farnsworth 2612 LLC", amount: 190, cadence: "Monthly", billingDate: 1, priorityTier: "5. Necessity", categoryName: "Property Tax" },
  { name: "HOA (Ft Farnsworth)", entity: "Ft Farnsworth 2612 LLC", amount: 703, cadence: "Monthly", billingDate: 1, priorityTier: "5. Necessity", categoryName: "HOA" },
];

// --- Step 1: Update/Create Categories ---

async function migrateCategories(categoryMap: Map<string, string>): Promise<Map<string, string>> {
  console.log("\n--- Step 1: Migrating categories ---");
  const schema = await getDbSchema(NOTION_DB.categories);
  let created = 0;
  let updated = 0;

  for (const cat of CATEGORY_DEFS) {
    const existingId = categoryMap.get(cat.name.toLowerCase());
    const properties: Record<string, any> = {};

    if (schema.has("Priority Tier")) {
      properties["Priority Tier"] = { select: { name: cat.priorityTier } };
    }
    if (schema.has("Subcategory")) {
      properties["Subcategory"] = {
        rich_text: [{ text: { content: cat.subcategory } }],
      };
    }
    if (schema.has("Type")) {
      properties["Type"] = { select: { name: cat.type } };
    }

    if (existingId) {
      // Update existing category with new fields
      if (schema.has("Icon")) {
        properties["Icon"] = {
          rich_text: [{ text: { content: cat.icon } }],
        };
      }
      await notionRequest(() =>
        notion.pages.update({ page_id: existingId, properties })
      );
      updated++;
    } else {
      // Create new category
      const titleProp = [...schema.entries()].find(([, t]) => t === "title");
      if (titleProp) {
        properties[titleProp[0]] = {
          title: [{ text: { content: cat.name } }],
        };
      }
      if (schema.has("Icon")) {
        properties["Icon"] = {
          rich_text: [{ text: { content: cat.icon } }],
        };
      }
      if (schema.has("Monthly Budget")) {
        properties["Monthly Budget"] = { number: 0 };
      }

      const page = await notionRequest(() =>
        notion.pages.create({
          parent: { database_id: NOTION_DB.categories },
          properties,
        })
      );
      categoryMap.set(cat.name.toLowerCase(), page.id);
      created++;
    }
  }

  console.log(`  Updated: ${updated}, Created: ${created}`);
  return categoryMap;
}

// --- Step 2: Migrate Recurring Expenses to Budgets DB ---

async function findBudgetByName(name: string): Promise<string | null> {
  const response = await notionRequest(() =>
    notion.databases.query({
      database_id: NOTION_DB.budgets,
      filter: {
        property: "Budget Name",
        title: { equals: name },
      },
      page_size: 1,
    })
  );
  return response.results.length > 0 ? response.results[0].id : null;
}

async function migrateRecurringExpenses(categoryMap: Map<string, string>) {
  console.log("\n--- Step 2: Migrating recurring expenses to Budgets DB ---");
  const schema = await getDbSchema(NOTION_DB.budgets);
  let created = 0;
  let skipped = 0;

  for (let i = 0; i < RECURRING_EXPENSES.length; i++) {
    const exp = RECURRING_EXPENSES[i];

    // Check if already exists (idempotent)
    const existingId = await findBudgetByName(exp.name);
    if (existingId) {
      skipped++;
      continue;
    }

    const properties: Record<string, any> = {};

    // Title
    const titleProp = [...schema.entries()].find(([, t]) => t === "title");
    if (titleProp) {
      properties[titleProp[0]] = {
        title: [{ text: { content: exp.name } }],
      };
    }

    if (schema.has("Budget Amount")) {
      properties["Budget Amount"] = { number: exp.amount };
    }
    if (schema.has("Cadence")) {
      properties["Cadence"] = { select: { name: exp.cadence } };
    }
    if (schema.has("Billing Date")) {
      properties["Billing Date"] = { number: exp.billingDate };
    }
    if (schema.has("Entity")) {
      properties["Entity"] = { select: { name: exp.entity } };
    }

    // Link to category
    const catId = categoryMap.get(exp.categoryName.toLowerCase());
    if (catId && schema.has("Category")) {
      properties["Category"] = { relation: [{ id: catId }] };
    }

    await notionRequest(() =>
      notion.pages.create({
        parent: { database_id: NOTION_DB.budgets },
        properties,
      })
    );
    created++;

    if ((created + skipped) % 10 === 0) {
      console.log(`  ${created + skipped}/${RECURRING_EXPENSES.length} processed`);
    }
  }

  console.log(`  Created: ${created}, Skipped (existing): ${skipped}`);
}

// --- Step 3: Tag Accounts with Entity ---

async function tagAccounts() {
  console.log("\n--- Step 3: Tagging accounts with Entity ---");
  let cursor: string | undefined = undefined;
  let tagged = 0;

  do {
    const response: any = await notionRequest(() =>
      notion.databases.query({
        database_id: NOTION_DB.accounts,
        start_cursor: cursor,
        page_size: 100,
      })
    );

    for (const page of response.results) {
      const entity = page.properties?.["Entity"]?.select?.name;
      if (!entity) {
        // Default all existing accounts to "Personal"
        await notionRequest(() =>
          notion.pages.update({
            page_id: page.id,
            properties: {
              Entity: { select: { name: "Personal" } },
            },
          })
        );
        tagged++;
      }
    }

    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  console.log(`  Tagged ${tagged} account(s) as Personal`);
}

// --- Main ---

async function main() {
  console.log("Budget migration starting...");

  // Build category map
  let categoryMap = await getCategoryMap();
  console.log(`Found ${categoryMap.size} existing categories`);

  // Step 1: Categories
  categoryMap = await migrateCategories(categoryMap);

  // Step 2: Recurring Expenses
  await migrateRecurringExpenses(categoryMap);

  // Step 3: Tag Accounts
  await tagAccounts();

  console.log("\nMigration complete.");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
