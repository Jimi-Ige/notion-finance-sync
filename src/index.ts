import { runSync } from "./sync.js";
import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// CLI entry point for `npm run sync`.
// Pulls new transactions from Plaid and pushes them to Notion.
// All output goes to both console and ~/.notion-finance/sync.log.
// ---------------------------------------------------------------------------

async function main() {
  const start = Date.now();
  logger.log("notion-finance-sync: starting sync...\n");

  try {
    await runSync();
  } catch (err: any) {
    logger.error(`\nSync failed: ${err.message}`);
    process.exit(1);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  logger.log(`\nDone in ${elapsed}s`);
}

main();
