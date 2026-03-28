import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  Products,
  CountryCode,
} from "plaid";
import { PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV } from "./config.js";

// ---------------------------------------------------------------------------
// Plaid client — thin wrapper around the official Node SDK.
// Adapted from legacy Mint Clone project (server/src/routes/plaid.ts).
// ---------------------------------------------------------------------------

const config = new Configuration({
  basePath: PlaidEnvironments[PLAID_ENV],
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": PLAID_CLIENT_ID,
      "PLAID-SECRET": PLAID_SECRET,
    },
  },
});

export const plaidClient = new PlaidApi(config);

/**
 * Create a Link token for the Plaid Link drop-in UI.
 * The token is short-lived (30 min) and scoped to one user session.
 */
export async function createLinkToken(): Promise<string> {
  const response = await plaidClient.linkTokenCreate({
    user: { client_user_id: "local-user" },
    client_name: "Notion Finance Sync",
    products: [Products.Transactions],
    country_codes: [CountryCode.Us],
    language: "en",
  });
  return response.data.link_token;
}

/**
 * Exchange a public token (from Plaid Link) for a permanent access token.
 * Returns the access token and item ID needed for all future API calls.
 */
export async function exchangePublicToken(publicToken: string) {
  const response = await plaidClient.itemPublicTokenExchange({
    public_token: publicToken,
  });
  return {
    accessToken: response.data.access_token,
    itemId: response.data.item_id,
  };
}

/**
 * Fetch all accounts for a given access token.
 * Used after linking to store account metadata alongside the access token.
 */
export async function getAccounts(accessToken: string) {
  const response = await plaidClient.accountsGet({
    access_token: accessToken,
  });
  return response.data.accounts;
}

/**
 * Fetch the human-readable institution name for a Plaid item.
 */
export async function getInstitutionName(
  institutionId: string
): Promise<string> {
  const response = await plaidClient.institutionsGetById({
    institution_id: institutionId,
    country_codes: [CountryCode.Us],
  });
  return response.data.institution.name;
}
