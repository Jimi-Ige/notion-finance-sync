import { readCredentials } from "./credentials.js";
import { readLogTail } from "./logger.js";
import { LOG_PATH } from "./config.js";

// ---------------------------------------------------------------------------
// Status command — shows linked institutions, sync health, and recent log.
// ---------------------------------------------------------------------------

async function main() {
  const store = await readCredentials();

  if (store.institutions.length === 0) {
    console.log("No linked institutions. Run `npm run link` to connect a bank.");
    return;
  }

  console.log(`\nLinked institutions (${store.institutions.length}):\n`);

  for (const inst of store.institutions) {
    const lastSync = inst.lastSync
      ? new Date(inst.lastSync).toLocaleString()
      : "never";
    const hasCursor = inst.cursor ? "yes" : "no";

    // Determine health status
    let health = "OK";
    if (!inst.lastSync) {
      health = "NEVER SYNCED";
    } else {
      const daysSince = (Date.now() - new Date(inst.lastSync).getTime()) / 86_400_000;
      if (daysSince > 7) health = "STALE (>7 days)";
      else if (daysSince > 2) health = "BEHIND (>2 days)";
    }

    console.log(`  ${inst.name}`);
    console.log(`    Status:    ${health}`);
    console.log(`    Accounts:  ${inst.accounts.length}`);
    inst.accounts.forEach((a) => console.log(`      - ${a.name} (${a.type})`));
    console.log(`    Last sync: ${lastSync}`);
    console.log(`    Cursor:    ${hasCursor}`);
    console.log();
  }

  // Show recent log activity
  const logTail = readLogTail(8);
  if (logTail) {
    console.log(`Recent sync log (${LOG_PATH}):\n`);
    console.log(logTail);
    console.log();
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
