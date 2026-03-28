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
| `npm run status` | Shows linked institutions and last sync time |

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

### 3. Share Notion databases with your integration

In each of your 5 Notion databases, click **...** → **Add connections** → select your integration.

### 4. Link a bank account

```bash
npm run link
```

This starts a local server on `127.0.0.1:3000`, opens your browser, and walks you through Plaid's bank authentication flow. Your access token is encrypted and stored locally at `~/.notion-finance/credentials.json`.

For sandbox testing, use credentials: `user_good` / `pass_good`.

### 5. Sync transactions

```bash
npm run sync
```

Pulls all new transactions since your last sync and writes them to your Notion Transactions database. Updates account balances in your Accounts database.

## Architecture

```
src/
├── index.ts          # Sync engine entry point
├── plaid.ts          # Plaid API client wrapper
├── notion.ts         # Notion API client + upsert logic
├── credentials.ts    # AES-256-GCM encrypted credential store
├── link-server.ts    # Express server for Plaid Link flow
├── link.html         # Plaid Link browser UI
├── config.ts         # Environment variable loader
└── intelligence/     # Post-MVP: cash flow engine, alerts (Phase 5+)
```

### Security

- Plaid access tokens are **encrypted at rest** using AES-256-GCM with a passphrase-derived key (PBKDF2, 100k iterations)
- The link server binds to `127.0.0.1` only — never exposed to your network
- All secrets and personal identifiers live in `.env` (gitignored)

### Notion Rate Limiting

The Notion API allows ~3 requests/second. This tool throttles writes using [`async-sema`](https://github.com/vercel/async-sema) and handles `429 Too Many Requests` with exponential backoff.

## Adapting for Your Workspace

This tool reads your Notion database schemas at runtime, so it adapts to your property names and types. To use it with your own workspace:

1. Create (or reuse) Notion databases for Accounts, Categories, Transactions, Budgets, and Savings Goals
2. Put their IDs in your `.env` file
3. The sync engine will query each database's schema before writing, matching properties by name

See [REFERENCES.md](./REFERENCES.md) for the open-source projects and documentation that informed this tool's design.

## Build Phases

| Phase | Status | Description |
|-------|--------|-------------|
| 1 | **Current** | Project scaffold + Plaid Link |
| 2 | Planned | Notion API integration |
| 3 | Planned | Sync engine with rules + manual override |
| 4 | Planned | Scheduling, logging, polish |
| 5+ | Future | Cash flow engine, alerts, AI categorization |

## License

MIT
