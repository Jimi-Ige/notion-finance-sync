import { runSync } from "./sync.js";

// ---------------------------------------------------------------------------
// CLI entry point for `npm run sync`.
// Pulls new transactions from Plaid and pushes them to Notion.
// ---------------------------------------------------------------------------

async function main() {
  const start = Date.now();
  console.log("notion-finance-sync: starting sync...\n");

  try {
    await runSync();
  } catch (err: any) {
    console.error(`\nSync failed: ${err.message}`);
    process.exit(1);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s`);
}

main();
