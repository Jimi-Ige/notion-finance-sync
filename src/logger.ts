import {
  appendFileSync,
  existsSync,
  readFileSync,
  statSync,
  renameSync,
} from "fs";
import { LOG_PATH } from "./config.js";
import { initCredentialStore } from "./credentials.js";

// ---------------------------------------------------------------------------
// Logger — dual output to console and ~/.notion-finance/sync.log.
//
// Every sync run is timestamped in the log file so you can review history,
// debug failures, and verify the Task Scheduler is running.
//
// Log rotation: if the file exceeds 1MB, the old log is renamed to
// sync.log.old (overwriting any previous .old file) before writing.
// ---------------------------------------------------------------------------

const MAX_LOG_SIZE = 1_048_576; // 1MB

let initialized = false;

function ensureLogDir(): void {
  if (initialized) return;
  initCredentialStore(); // Creates ~/.notion-finance/ if missing
  initialized = true;
}

function rotateIfNeeded(): void {
  try {
    if (existsSync(LOG_PATH) && statSync(LOG_PATH).size > MAX_LOG_SIZE) {
      renameSync(LOG_PATH, LOG_PATH + ".old");
    }
  } catch {
    // Non-critical — continue without rotation
  }
}

function writeToFile(level: string, message: string): void {
  ensureLogDir();
  rotateIfNeeded();

  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level}] ${message}\n`;

  try {
    appendFileSync(LOG_PATH, line, "utf8");
  } catch {
    // If we can't write to the log file, don't crash the sync
  }
}

export const logger = {
  log(message: string): void {
    console.log(message);
    writeToFile("INFO", message);
  },

  warn(message: string): void {
    console.warn(message);
    writeToFile("WARN", message);
  },

  error(message: string): void {
    console.error(message);
    writeToFile("ERROR", message);
  },

  /** Log a divider to mark the start of a sync run. */
  syncStart(): void {
    const divider = `\n${"=".repeat(60)}\nSync started at ${new Date().toISOString()}\n${"=".repeat(60)}`;
    writeToFile("INFO", divider);
  },
};

/**
 * Read the last N lines of the sync log.
 * Returns empty string if the log doesn't exist.
 */
export function readLogTail(lines: number = 10): string {
  ensureLogDir();

  if (!existsSync(LOG_PATH)) return "";

  try {
    const content = readFileSync(LOG_PATH, "utf8");
    const allLines = content.trim().split("\n");
    return allLines.slice(-lines).join("\n");
  } catch {
    return "";
  }
}
