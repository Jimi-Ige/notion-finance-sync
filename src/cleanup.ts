import { notion } from "./notion.js";
import { NOTION_DB } from "./config.js";
import { notionRequest } from "./rate-limiter.js";

// ---------------------------------------------------------------------------
// Cleanup command — archives all pages in the Transactions and Accounts DBs.
// Use this to remove sandbox/test data before importing real transactions.
// ---------------------------------------------------------------------------

async function archiveAllPages(
  databaseId: string,
  label: string
): Promise<number> {
  let archived = 0;
  let cursor: string | undefined = undefined;

  do {
    const response: any = await notionRequest(() =>
      notion.databases.query({
        database_id: databaseId,
        start_cursor: cursor,
        page_size: 100,
      })
    );

    for (const page of response.results) {
      await notionRequest(() =>
        notion.pages.update({ page_id: page.id, archived: true })
      );
      archived++;
    }

    cursor = response.has_more ? response.next_cursor : undefined;
    if (archived > 0 && archived % 50 === 0) {
      console.log(`  ${label}: ${archived} archived so far...`);
    }
  } while (cursor);

  return archived;
}

async function main() {
  console.log("Cleaning sandbox data from Notion...\n");

  const txCount = await archiveAllPages(NOTION_DB.transactions, "Transactions");
  console.log(`  Transactions: ${txCount} archived`);

  const acctCount = await archiveAllPages(NOTION_DB.accounts, "Accounts");
  console.log(`  Accounts:     ${acctCount} archived`);

  console.log(`\nDone. ${txCount + acctCount} total pages archived.`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
