import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { exec } from "child_process";
import { LINK_SERVER_HOST, LINK_SERVER_PORT } from "./config.js";
import { createLinkToken, exchangePublicToken, getAccounts } from "./plaid.js";
import { addInstitution, type StoredAccount } from "./credentials.js";

// ---------------------------------------------------------------------------
// Plaid Link server — minimal Express app that serves the Link drop-in UI.
//
// Runs on 127.0.0.1 only (never exposed to the network). Auto-opens the
// browser and shuts down after a successful bank link.
//
// Endpoints:
//   GET  /                 → Serves link.html
//   POST /create-link-token → Returns { link_token } for Plaid Link
//   POST /exchange-token    → Exchanges public token, stores credentials
//
// Reference: plaid/tutorial-resources/transactions
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());

// Serve the Plaid Link HTML page
app.get("/", (_req, res) => {
  res.sendFile(join(__dirname, "link.html"));
});

// Create a Plaid Link token for the frontend
app.post("/create-link-token", async (_req, res) => {
  try {
    const linkToken = await createLinkToken();
    res.json({ link_token: linkToken });
  } catch (err) {
    console.error("Failed to create link token:", err);
    res.status(500).json({ error: "Failed to create link token" });
  }
});

// Exchange public token → access token, fetch accounts, store encrypted
app.post("/exchange-token", async (req, res) => {
  try {
    const { public_token, institution_id, institution_name } = req.body;

    if (!public_token) {
      res.status(400).json({ error: "Missing public_token" });
      return;
    }

    // Exchange for permanent access token
    const { accessToken, itemId } = await exchangePublicToken(public_token);

    // Fetch accounts for this institution
    const plaidAccounts = await getAccounts(accessToken);
    const accounts: StoredAccount[] = plaidAccounts.map((a) => ({
      accountId: a.account_id,
      name: a.name,
      type: a.type?.toString() ?? "unknown",
      subtype: a.subtype?.toString() ?? null,
    }));

    // Use the institution name from Plaid Link metadata, or fall back to ID
    const name = institution_name || institution_id || "Unknown Institution";

    // Store encrypted credentials
    await addInstitution(accessToken, itemId, name, accounts);

    console.log(`\nLinked: ${name} (${accounts.length} account(s))`);
    accounts.forEach((a) => console.log(`  - ${a.name} (${a.type})`));

    res.json({
      institution: name,
      accountCount: accounts.length,
    });

    // Graceful shutdown after successful link
    console.log("\nBank linked successfully. Shutting down link server...");
    setTimeout(() => {
      server.close(() => process.exit(0));
    }, 1000);
  } catch (err) {
    console.error("Token exchange failed:", err);
    res.status(500).json({ error: "Token exchange failed" });
  }
});

// Start the server and open the browser
const server = app.listen(LINK_SERVER_PORT, LINK_SERVER_HOST, () => {
  const url = `http://${LINK_SERVER_HOST}:${LINK_SERVER_PORT}`;
  console.log(`\nPlaid Link server running at ${url}`);
  console.log("Opening browser...\n");

  // Open browser — cross-platform
  const openCmd =
    process.platform === "win32"
      ? `start ${url}`
      : process.platform === "darwin"
        ? `open ${url}`
        : `xdg-open ${url}`;

  exec(openCmd, (err) => {
    if (err) console.log(`Could not open browser automatically. Visit: ${url}`);
  });
});
