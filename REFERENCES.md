# References

External repositories and resources studied before and during development. These informed architectural decisions, edge case handling, and implementation patterns. None are direct dependencies — they are learning references only.

## Plaid Integration

| Repository | Language | Why It's Here |
|-----------|----------|---------------|
| [plaid/pattern](https://github.com/plaid/pattern) | JS/Node | Official Plaid reference app. Production-tested `/transactions/sync` with cursor management, pagination error recovery (`TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`), and webhook-driven sync. Our sync engine mirrors their cursor persistence strategy. |
| [plaid/tutorial-resources/transactions](https://github.com/plaid/tutorial-resources/tree/main/transactions) | JS/Node | Minimal Plaid Link + sync starter. VanillaJS frontend with Plaid Link CDN drop-in — structurally closest to our link server. |
| [plaid/quickstart](https://github.com/plaid/quickstart) | Multi | Official quickstart for Plaid Link and API. Used for initial setup validation. |
| [plaid/plaid-node](https://github.com/plaid/plaid-node) | TS | Official Node SDK. Source of truth for `transactionsSync`, `accountsGet`, and `linkTokenCreate` signatures. |

## Plaid → Workspace Sync (Prior Art)

| Repository | Language | Why It's Here |
|-----------|----------|---------------|
| [onmax/joxi](https://github.com/onmax/joxi) | TS/Deno | Bank → Notion finance tracker. Uses Nordigen (not Plaid) for banking, but their Notion database creation and schema management patterns are directly relevant. Runs on a schedule via GitHub Actions. |
| [spencerc99/plaid-coda-transactions](https://github.com/spencerc99/plaid-coda-transactions) | Python | Plaid → Coda doc. Validates the "Plaid → document-based workspace" pattern. Simple bank config via JSON file. |
| [azeemba/lpaid](https://github.com/azeemba/lpaid) | JS/Node | Personal Plaid money tracker. Key insight: Plaid provides current balances only, not history — confirmed our decision to snapshot net worth after every sync. |
| [mbafford/plaid-sync](https://github.com/mbafford/plaid-sync) | Python | Plaid CLI → SQLite. Clean CLI UX — clear sync summaries. Informed our console output design. |

## Notion API

| Resource | Type | Why It's Here |
|----------|------|---------------|
| [Notion SDK TypeScript Starter](https://github.com/makenotion/notion-sdk-typescript-starter) | Template | Official TS starter. Project structure and dotenv config patterns. |
| [Notion API Rate Limits](https://developers.notion.com/reference/request-limits) | Docs | 3 req/sec average, 2700 per 15 min. Informed our `async-sema` throttling strategy. |
| [Thomas Frank — Handling Notion Rate Limits](https://thomasjfrank.com/how-to-handle-notion-api-request-limits/) | Guide | Practical patterns for batching, queuing, and 429 backoff with Notion API. |

## Encryption

| Resource | Type | Why It's Here |
|----------|------|---------------|
| [AES-256-GCM + PBKDF2 Gist](https://gist.github.com/AndiDittrich/4629e7db04819244e843) | Gist | Reference implementation for AES-256-GCM with random IV + salt in Node.js. Our credentials encryption follows this pattern. |
| [zachelrath/encrypt-at-rest](https://github.com/zachelrath/encrypt-at-rest) | Library | Reviewed but not adopted. We use Node's built-in `crypto` directly to minimize dependencies. |

## Key Lessons Applied

1. **Cursor pagination resilience** (from plaid/pattern): Preserve old cursor during pagination. On `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`, restart from the original cursor, not the current one.
2. **Pending → posted transaction churn** (from Plaid docs): Pending transactions are *removed* and *re-added* as posted. This is normal, not data loss.
3. **Balance snapshots** (from azeemba/lpaid): Plaid only provides current balances. We must snapshot after every sync to build history.
4. **Notion write throttling** (from Thomas Frank): Throttle to ~1 req/500ms for writes. Use `async-sema` RateLimit. Handle 429 with `Retry-After` header.
5. **First sync latency** (from Plaid docs): Initial `/transactions/sync` call can be up to 8x slower. Don't hard-code tight timeouts.
6. **Max pagination count** (from Plaid docs): Use `count: 500` to minimize pagination errors.
