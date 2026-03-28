import { randomBytes, createCipheriv, createDecipheriv, pbkdf2Sync } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { createInterface } from "readline";
import { DATA_DIR, CREDENTIALS_PATH, CREDENTIAL_PASSPHRASE } from "./config.js";

// ---------------------------------------------------------------------------
// Encrypted credential store — AES-256-GCM with PBKDF2 key derivation.
//
// Stores Plaid access tokens, item IDs, account metadata, and sync cursors
// in ~/.notion-finance/credentials.json, encrypted at rest.
//
// File format (JSON):
//   { salt: hex, iv: hex, authTag: hex, ciphertext: hex }
//
// Decrypted payload:
//   { institutions: Institution[] }
//
// Encryption reference: https://gist.github.com/AndiDittrich/4629e7db04819244e843
// ---------------------------------------------------------------------------

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12; // 96 bits — recommended for GCM
const SALT_LENGTH = 32; // 256 bits
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_DIGEST = "sha512";

// --- Types ---

export interface StoredAccount {
  accountId: string;
  name: string;
  type: string;
  subtype: string | null;
}

export interface Institution {
  accessToken: string;
  itemId: string;
  name: string;
  accounts: StoredAccount[];
  cursor: string | null;
  lastSync: string | null;
}

export interface CredentialStore {
  institutions: Institution[];
}

// --- Encryption helpers ---

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, KEY_LENGTH, PBKDF2_DIGEST);
}

function encrypt(data: string, passphrase: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = deriveKey(passphrase, salt);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(data, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return JSON.stringify({
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
    ciphertext: encrypted.toString("hex"),
  });
}

function decrypt(fileContents: string, passphrase: string): string {
  const { salt, iv, authTag, ciphertext } = JSON.parse(fileContents);

  const key = deriveKey(passphrase, Buffer.from(salt, "hex"));
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, "hex"));
  decipher.setAuthTag(Buffer.from(authTag, "hex"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "hex")),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

// --- Passphrase prompt ---

let cachedPassphrase: string | null = null;

async function getPassphrase(): Promise<string> {
  if (cachedPassphrase) return cachedPassphrase;

  if (CREDENTIAL_PASSPHRASE) {
    cachedPassphrase = CREDENTIAL_PASSPHRASE;
    return cachedPassphrase;
  }

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const passphrase = await new Promise<string>((resolve) => {
    rl.question("Enter encryption passphrase: ", (answer) => {
      rl.close();
      resolve(answer);
    });
  });

  if (!passphrase) {
    throw new Error("Passphrase cannot be empty.");
  }

  cachedPassphrase = passphrase;
  return passphrase;
}

// --- Public API ---

/** Ensure the data directory exists. */
export function initCredentialStore(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

/** Read and decrypt the credential store. Returns empty store if file doesn't exist. */
export async function readCredentials(): Promise<CredentialStore> {
  initCredentialStore();

  if (!existsSync(CREDENTIALS_PATH)) {
    return { institutions: [] };
  }

  const passphrase = await getPassphrase();
  const fileContents = readFileSync(CREDENTIALS_PATH, "utf8");

  try {
    const json = decrypt(fileContents, passphrase);
    return JSON.parse(json) as CredentialStore;
  } catch {
    throw new Error(
      "Failed to decrypt credentials. Wrong passphrase, or the file is corrupted."
    );
  }
}

/** Encrypt and write the credential store to disk. */
export async function saveCredentials(store: CredentialStore): Promise<void> {
  initCredentialStore();

  const passphrase = await getPassphrase();
  const json = JSON.stringify(store, null, 2);
  const encrypted = encrypt(json, passphrase);

  writeFileSync(CREDENTIALS_PATH, encrypted, "utf8");
}

/**
 * Add a newly linked institution to the credential store.
 * If the institution (by itemId) already exists, it is replaced.
 */
export async function addInstitution(
  accessToken: string,
  itemId: string,
  institutionName: string,
  accounts: StoredAccount[]
): Promise<void> {
  const store = await readCredentials();

  // Replace if already linked (re-link scenario)
  store.institutions = store.institutions.filter((i) => i.itemId !== itemId);

  store.institutions.push({
    accessToken,
    itemId,
    name: institutionName,
    accounts,
    cursor: null,
    lastSync: null,
  });

  await saveCredentials(store);
}

/**
 * Update the sync cursor and last-sync timestamp for an institution.
 */
export async function updateSyncState(
  itemId: string,
  cursor: string,
  timestamp: string
): Promise<void> {
  const store = await readCredentials();
  const institution = store.institutions.find((i) => i.itemId === itemId);

  if (!institution) {
    throw new Error(`Institution with itemId ${itemId} not found in credentials.`);
  }

  institution.cursor = cursor;
  institution.lastSync = timestamp;

  await saveCredentials(store);
}
