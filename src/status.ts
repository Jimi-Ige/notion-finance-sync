import { readCredentials } from "./credentials.js";

// ---------------------------------------------------------------------------
// Status command — shows linked institutions and last sync time.
// Full implementation in Phase 4; this is a working early version.
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

    console.log(`  ${inst.name}`);
    console.log(`    Accounts:  ${inst.accounts.length}`);
    inst.accounts.forEach((a) => console.log(`      - ${a.name} (${a.type})`));
    console.log(`    Last sync: ${lastSync}`);
    console.log(`    Cursor:    ${hasCursor}`);
    console.log();
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
