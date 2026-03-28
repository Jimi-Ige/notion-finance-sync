# notion-finance-sync

A self-hosted CLI tool that syncs your bank transactions into Notion via Plaid. Zero cost, no cloud, no database — Notion is the database and the UI.

Built as a personal alternative to [Finta](https://www.finta.io/) and [Tiller Money](https://www.tillerhq.com/).

## How It Works

```
Your Banks → Plaid API → This CLI → Notion API → Your Notion Workspace
```

Three commands:

| Command | What It Does |
|---------|-------------|
| `npm run link` | Opens a browser to authenticate a bank via Plaid Link (one-time per bank) |
| `npm run sync` | Pulls new transactions from Plaid, pushes them to your Notion databases |
| `npm run status` | Shows linked institutions, sync health, and recent log output |

## Prerequisites

- **Node.js** >= 18
- **Plaid account** — [Sign up for free](https://dashboard.plaid.com/signup) (Development environment supports 100 connections at $0)
- **Notion account** with an [internal integration](https://www.notion.so/my-integrations)
- **Notion databases** for Accounts, Categories, Transactions, Budgets, and Savings Goals — shared with your integration

## Setup

### 1. Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/notion-finance-sync.git
cd notion-finance-sync
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in your `.env` with:
- Plaid API credentials (from [Plaid Dashboard](https://dashboard.plaid.com/developers/keys))
- Notion integration token (from [My Integrations](https://www.notion.so/my-integrations))
- Notion database IDs (open each database in Notion → Share → Copy link → extract the 32-character hex ID from the URL)
- An encryption passphrase for securing Plaid tokens at rest

### 3. Prepare your Notion databases

The sync engine needs a few properties to exist in your Notion databases. If they're missing, the first sync will warn you. Add these before syncing:

**Accounts DB** — add if missing:
- `Plaid Account ID` (Text) — used for deduplication
- `Institution` (Text) — bank name
- `Last Synced` (Date)

**Transactions DB** — add if missing:
- `Plaid Transaction ID` (Text) — used for deduplication
- `Merchant` (Text)
- `Pending` (Checkbox)
- `Manual Override` (Checkbox) — check this to prevent sync from overwriting your edits

### 4. Share Notion databases with your integration

In each of your 5 Notion databases (or a parent page that contains them), click **...** → **Add connections** → select your integration.

### 5. Link a bank account

```bash
npm run link
```

This starts a local server on `127.0.0.1:3000`, opens your browser, and walks you through Plaid's bank authentication flow. Your access token is encrypted and stored locally at `~/.notion-finance/credentials.json`.

For sandbox testing, use credentials: `user_good` / `pass_good`, phone: any US number, code: `123456`.

### 6. Sync transactions

```bash
npm run sync
```

Pulls all new transactions since your last sync and writes them to your Notion Transactions database. Updates account balances in your Accounts database. Computes a net worth snapshot (assets - liabilities) on every run.

### 7. Set up daily auto-sync (optional)

The sync should feel invisible — data just appears in Notion each morning.

```powershell
# Run from the project root (requires admin for Task Scheduler)
powershell -ExecutionPolicy Bypass -File scripts\setup-scheduler.ps1
```

This registers a Windows Task Scheduler task that runs `npm run sync` daily at 6:00 AM. To change the time, edit the `-At` parameter in `scripts/setup-scheduler.ps1`.

To verify the task is registered:
```powershell
Get-ScheduledTask -TaskName "NotionFinanceSync"
```

To run it manually:
```powershell
Start-ScheduledTask -TaskName "NotionFinanceSync"
```

To remove it:
```powershell
Unregister-ScheduledTask -TaskName "NotionFinanceSync" -Confirm:$false
```

## Architecture

```
src/
├── index.ts          # Sync engine entry point
├── sync.ts           # Core sync loop — Plaid → Rules → Notion
├── plaid.ts          # Plaid API client wrapper
├── notion.ts         # Notion API client + upsert logic
├── rules.ts          # Local auto-categorization rules engine
├── credentials.ts    # AES-256-GCM encrypted credential store
├── rate-limiter.ts   # Notion API throttle + 429 retry
├── logger.ts         # Dual output — console + ~/.notion-finance/sync.log
├── link-server.ts    # Express server for Plaid Link flow
├── link.html         # Plaid Link browser UI
├── config.ts         # Environment variable loader
└── intelligence/     # Post-MVP: cash flow engine, alerts (Phase 5+)

scripts/
├── setup-scheduler.ps1  # Register daily Windows Task Scheduler task
└── run-sync.bat          # Batch wrapper for Task Scheduler
```

### How the Sync Works

1. Read encrypted credentials → get Plaid access tokens and sync cursors
2. For each linked bank: call Plaid's `/transactions/sync` (cursor-based, incremental)
3. Apply local categorization rules (`rules.json`) — first match wins
4. Fall back to Plaid's built-in category if no rule matches
5. Upsert transactions and accounts into Notion (respects Manual Override)
6. Archive removed transactions
7. Save new sync cursor for next run
8. Snapshot net worth (total assets - total liabilities)

### Auto-Categorization Rules

Edit `rules.json` to define your own merchant → category mappings:

```json
[
  { "match": { "merchant_contains": "STARBUCKS" }, "set": { "category": "Coffee" } },
  { "match": { "merchant_contains": "UBER" }, "set": { "category": "Transportation" } },
  { "match": { "amount_gt": 1000, "type": "expense" }, "set": { "flag": true } }
]
```

Rules are evaluated in order. First match wins. If no rule matches, the tool falls back to Plaid's `personal_finance_category`. If a user has set the `Manual Override` checkbox on a transaction in Notion, sync will never overwrite that category.

### Security

- Plaid access tokens are **encrypted at rest** using AES-256-GCM with a passphrase-derived key (PBKDF2, 100k iterations)
- The link server binds to `127.0.0.1` only — never exposed to your network
- All secrets and personal identifiers live in `.env` (gitignored)

### Notion Rate Limiting

The Notion API allows ~3 requests/second. This tool throttles writes using [`async-sema`](https://github.com/vercel/async-sema) and handles `429 Too Many Requests` with exponential backoff.

### Logging

All sync output is written to both the console and `~/.notion-finance/sync.log`. The log rotates automatically at 1MB. Use `npm run status` to see the tail of the log.

## Adapting for Your Workspace

This tool reads your Notion database schemas at runtime, so it adapts to your property names and types. To use it with your own workspace:

1. Create (or reuse) Notion databases for Accounts, Categories, Transactions, Budgets, and Savings Goals
2. Add the required properties listed in the Setup section above
3. Put their IDs in your `.env` file
4. The sync engine will query each database's schema before writing, matching properties by name

See [REFERENCES.md](./REFERENCES.md) for the open-source projects and documentation that informed this tool's design.

## Build Phases

| Phase | Status | Description |
|-------|--------|-------------|
| 1 | Complete | Project scaffold + Plaid Link |
| 2 | Complete | Notion API integration |
| 3 | Complete | Sync engine with rules + manual override |
| 4 | **Current** | Scheduling, logging, polish |
| 5+ | Future | Cash flow engine, alerts, AI categorization |

## License

MIT
