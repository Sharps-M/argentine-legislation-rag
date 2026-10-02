export const USER_AGENT =
  "NormativaAR/0.1 (+https://github.com/Sharps-M/argentine-legislation-rag)";

export type FetchedPage =
  | { ok: true; bytes: Uint8Array; contentType: string | null }
  | { ok: false; status: number | null; reason: string };

export type PageFetcher = (url: string) => Promise<FetchedPage>;

export type PoliteFetcherOptions = {
  /** Minimum time between two requests, in milliseconds. */
  delayMs?: number;
  timeoutMs?: number;
  /** Extra attempts after a network error, a 429 or a 5xx response. */
  retries?: number;
  userAgent?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const isRetryable = (status: number) => status === 429 || status >= 500;

/**
 * Builds a fetcher that behaves well towards the server it reads from: it
 * identifies itself with a descriptive User-Agent, sends one request at a
 * time, waits between requests and backs off before retrying.
 *
 * Client errors (403, 404...) are returned, not retried: asking again will not
 * change the answer, and insisting is exactly what a polite client avoids.
 */
export function createPoliteFetcher(options: PoliteFetcherOptions = {}): PageFetcher {
  const {
    delayMs = 1000,
    timeoutMs = 20_000,
    retries = 2,
    userAgent = USER_AGENT,
    fetch: fetchImpl = fetch,
    sleep = defaultSleep,
    now = Date.now,
  } = options;

  let lastRequestAt: number | null = null;

  const waitForTurn = async () => {
    if (lastRequestAt !== null) {
      const elapsed = now() - lastRequestAt;
      if (elapsed < delayMs) await sleep(delayMs - elapsed);
    }
    lastRequestAt = now();
  };

  return async (url) => {
    let failure: FetchedPage = { ok: false, status: null, reason: "not attempted" };

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) await sleep(delayMs * 2 ** attempt);
      await waitForTurn();

      try {
        const response = await fetchImpl(url, {
          headers: { "user-agent": userAgent, accept: "text/html" },
          signal: AbortSignal.timeout(timeoutMs),
          redirect: "follow",
        });

        if (response.ok) {
          return {
            ok: true,
            bytes: new Uint8Array(await response.arrayBuffer()),
            contentType: response.headers.get("content-type"),
          };
        }

        failure = {
          ok: false,
          status: response.status,
          reason: `HTTP ${response.status}`,
        };
        if (!isRetryable(response.status)) return failure;
      } catch (error) {
        failure = {
          ok: false,
          status: null,
          reason: error instanceof Error ? error.message : "network error",
        };
      }
    }

    return failure;
  };
}
