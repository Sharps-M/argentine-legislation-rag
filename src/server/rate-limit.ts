/**
 * How many answers are given per minute. Each answer is one to three calls to
 * a chat model, and a hosted model's free tier counts its calls per minute and
 * per day: an open endpoint lets anyone spend that quota for everyone.
 *
 * Two limits apply together: one per client, so that a single reader cannot
 * take every answer, and one in total, so that many clients (or one client with
 * many addresses) cannot either.
 */

/** Requests within a moving window of time, for each key. */
export type RateLimiter = {
  /** How long, in ms, until `key` may make another request; 0 means now. */
  wait: (key: string) => number;
  /** Counts a request of `key`. */
  take: (key: string) => void;
  /** How many keys are being counted: what the limiter holds in memory. */
  size: () => number;
};

export type RateLimiterOptions = {
  /** Requests allowed per window; 0 allows any number. */
  limit: number;
  windowMs?: number;
  /** A clock in milliseconds; the tests bring their own. */
  now?: () => number;
};

/** Keys kept before the ones with nothing left in the window are swept. */
const SWEEP_ABOVE = 10_000;

export function createRateLimiter({
  limit,
  windowMs = 60_000,
  now = Date.now,
}: RateLimiterOptions): RateLimiter {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new RangeError(`limit must be a whole number from 0, got ${limit}`);
  }
  /** When each key made its requests, oldest first, within the window. */
  const requests = new Map<string, number[]>();

  const recent = (key: string) => {
    const since = now() - windowMs;
    const times = (requests.get(key) ?? []).filter((time) => time > since);
    if (times.length > 0) requests.set(key, times);
    else requests.delete(key);
    return times;
  };

  return {
    wait(key) {
      if (limit === 0) return 0;
      const times = recent(key);
      if (times.length < limit) return 0;
      // A place frees up when the oldest request that still counts leaves the window.
      return times[times.length - limit]! + windowMs - now();
    },
    take(key) {
      if (limit === 0) return;
      if (requests.size > SWEEP_ABOVE) {
        for (const other of [...requests.keys()]) recent(other);
      }
      requests.set(key, [...recent(key), now()]);
    },
    size: () => requests.size,
  };
}

export type Admission =
  | { ok: true }
  | {
      ok: false;
      /** Which limit was reached. */
      limit: "client" | "total";
      /** How long until the request would be let through. */
      retryAfterMs: number;
    };

export type AnswerLimits = {
  /** Lets a request of `client` through and counts it, or says how long to wait. */
  admit: (client: string) => Admission;
};

export type AnswerLimitsOptions = {
  /** Answers per minute for each client; 0 allows any number. */
  perClient: number;
  /** Answers per minute for everyone together; 0 allows any number. */
  total: number;
  now?: () => number;
};

const EVERYONE = "*";

export function createAnswerLimits({
  perClient,
  total,
  now,
}: AnswerLimitsOptions): AnswerLimits {
  const clients = createRateLimiter({ limit: perClient, now });
  const all = createRateLimiter({ limit: total, now });

  return {
    admit(client) {
      const clientWait = clients.wait(client);
      if (clientWait > 0)
        return { ok: false, limit: "client", retryAfterMs: clientWait };

      const totalWait = all.wait(EVERYONE);
      if (totalWait > 0) return { ok: false, limit: "total", retryAfterMs: totalWait };

      // Counted only when let through: waiting does not make the wait longer.
      clients.take(client);
      all.take(EVERYONE);
      return { ok: true };
    },
  };
}

/**
 * Who is asking: the first address of `X-Forwarded-For`, then `X-Real-IP`.
 * Both are written by the proxy in front of the server; without one, a client
 * can write them itself, and the total limit is what still holds.
 */
export function clientOf(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || headers.get("x-real-ip")?.trim() || "unknown";
}
