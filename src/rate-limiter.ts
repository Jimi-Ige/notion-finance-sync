import { RateLimit } from "async-sema";

// ---------------------------------------------------------------------------
// Notion API rate limiter — wraps every API call with throttling and retry.
//
// Notion allows ~3 req/sec average (2700 per 15 min). We throttle to 2/sec
// to leave headroom for writes to "settle" in the parent database.
//
// On HTTP 429, we respect the Retry-After header and retry up to 3 times
// with exponential backoff.
//
// Reference: https://developers.notion.com/reference/request-limits
// Reference: https://thomasjfrank.com/how-to-handle-notion-api-request-limits/
// ---------------------------------------------------------------------------

const rateLimiter = RateLimit(2); // 2 requests per second

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;

/**
 * Execute a Notion API call with rate limiting and retry on 429.
 *
 * Usage:
 *   const page = await notionRequest(() => notion.pages.create({ ... }));
 */
export async function notionRequest<T>(fn: () => Promise<T>): Promise<T> {
  await rateLimiter();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const status = err?.status ?? err?.code;

      if (status === 429 && attempt < MAX_RETRIES) {
        // Respect Retry-After header if present, otherwise exponential backoff
        const retryAfter = err?.headers?.["retry-after"];
        const waitMs = retryAfter
          ? Number(retryAfter) * 1000
          : BASE_BACKOFF_MS * Math.pow(2, attempt);

        console.warn(
          `Notion rate limited (429). Retrying in ${Math.round(waitMs / 1000)}s... ` +
            `(attempt ${attempt + 1}/${MAX_RETRIES})`
        );

        await sleep(waitMs);
        await rateLimiter(); // Re-acquire rate limit slot
        continue;
      }

      throw err;
    }
  }

  // Unreachable, but satisfies TypeScript
  throw new Error("Max retries exceeded");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
