import { describe, expect, it } from "vitest";

import { clientOf, createAnswerLimits, createRateLimiter } from "./rate-limit";

/** A clock that only moves when told to. */
const clock = () => {
  let time = 1_000_000;
  return { now: () => time, pass: (ms: number) => (time += ms) };
};

describe("createRateLimiter", () => {
  it("lets requests through up to the limit, then says how long to wait", () => {
    const { now, pass } = clock();
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, now });

    limiter.take("a");
    pass(10_000);
    expect(limiter.wait("a")).toBe(0);
    limiter.take("a");

    // The first request leaves the window 60 s after it was made.
    expect(limiter.wait("a")).toBe(50_000);
  });

  it("frees a place as each request leaves the window", () => {
    const { now, pass } = clock();
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, now });
    limiter.take("a");
    pass(10_000);
    limiter.take("a");

    pass(50_000);
    expect(limiter.wait("a")).toBe(0);
    limiter.take("a");
    // Now the second one is the oldest that counts.
    expect(limiter.wait("a")).toBe(10_000);
  });

  it("counts each key apart", () => {
    const { now } = clock();
    const limiter = createRateLimiter({ limit: 1, now });
    limiter.take("a");

    expect(limiter.wait("a")).toBeGreaterThan(0);
    expect(limiter.wait("b")).toBe(0);
  });

  it("allows any number with a limit of 0", () => {
    const { now } = clock();
    const limiter = createRateLimiter({ limit: 0, now });
    for (let index = 0; index < 100; index += 1) limiter.take("a");

    expect(limiter.wait("a")).toBe(0);
  });

  it("counts a minute by default", () => {
    const { now, pass } = clock();
    const limiter = createRateLimiter({ limit: 1, now });
    limiter.take("a");

    pass(59_999);
    expect(limiter.wait("a")).toBe(1);
    pass(1);
    expect(limiter.wait("a")).toBe(0);
  });

  it("rejects a limit that is not a whole number from 0", () => {
    expect(() => createRateLimiter({ limit: -1 })).toThrow(RangeError);
    expect(() => createRateLimiter({ limit: 1.5 })).toThrow(RangeError);
  });

  it("forgets clients whose requests have left the window when there are too many", () => {
    const { now, pass } = clock();
    const limiter = createRateLimiter({ limit: 1, now });
    for (let index = 0; index <= 10_000; index += 1) limiter.take(`old-${index}`);

    pass(60_000);
    limiter.take("new");

    expect(limiter.size()).toBe(1);
    // Still answers right for a client that was swept away.
    expect(limiter.wait("old-0")).toBe(0);
    expect(limiter.wait("new")).toBe(60_000);
  });

  it("forgets a client as soon as its last request leaves the window", () => {
    const { now, pass } = clock();
    const limiter = createRateLimiter({ limit: 1, now });
    limiter.take("a");
    pass(60_000);

    expect(limiter.wait("a")).toBe(0);
    expect(limiter.size()).toBe(0);
  });

  it("keeps nothing when it allows any number", () => {
    const limiter = createRateLimiter({ limit: 0 });
    limiter.take("a");

    expect(limiter.size()).toBe(0);
  });

  it("waits for enough requests to leave when more than the limit were counted", () => {
    const { now, pass } = clock();
    const limiter = createRateLimiter({ limit: 1, now });
    limiter.take("a");
    pass(10_000);
    limiter.take("a");

    // Two count against a limit of one: both have to leave.
    expect(limiter.wait("a")).toBe(60_000);
  });
});

describe("createAnswerLimits", () => {
  it("lets a client through up to its own limit", () => {
    const { now } = clock();
    const limits = createAnswerLimits({ perClient: 2, total: 10, now });

    expect(limits.admit("a")).toEqual({ ok: true });
    expect(limits.admit("a")).toEqual({ ok: true });
    expect(limits.admit("a")).toEqual({
      ok: false,
      limit: "client",
      retryAfterMs: 60_000,
    });
    expect(limits.admit("b")).toEqual({ ok: true });
  });

  it("stops everyone once the total is reached", () => {
    const { now, pass } = clock();
    const limits = createAnswerLimits({ perClient: 5, total: 2, now });
    limits.admit("a");
    pass(1_000);
    limits.admit("b");

    expect(limits.admit("c")).toEqual({
      ok: false,
      limit: "total",
      retryAfterMs: 59_000,
    });
  });

  it("does not count a request it turns away", () => {
    const { now, pass } = clock();
    const limits = createAnswerLimits({ perClient: 1, total: 2, now });
    limits.admit("a");
    // Turned away by its own limit: the total keeps its place for others.
    for (let index = 0; index < 5; index += 1) limits.admit("a");

    expect(limits.admit("b")).toEqual({ ok: true });
    // Turned away by the total: its own count does not grow.
    expect(limits.admit("c")).toMatchObject({ ok: false, limit: "total" });
    pass(60_000);
    expect(limits.admit("c")).toEqual({ ok: true });
  });

  it("has no limits when both are 0", () => {
    const limits = createAnswerLimits({ perClient: 0, total: 0 });
    for (let index = 0; index < 50; index += 1) {
      expect(limits.admit("a")).toEqual({ ok: true });
    }
  });
});

describe("clientOf", () => {
  it("takes the first address the proxy forwarded", () => {
    expect(
      clientOf(
        new Headers({
          "x-forwarded-for": " 203.0.113.7 , 10.0.0.1",
          "x-real-ip": "10.0.0.2",
        }),
      ),
    ).toBe("203.0.113.7");
  });

  it("falls back on X-Real-IP, then on a single shared key", () => {
    expect(clientOf(new Headers({ "x-real-ip": " 203.0.113.9 " }))).toBe("203.0.113.9");
    expect(clientOf(new Headers({ "x-forwarded-for": " , " }))).toBe("unknown");
    expect(clientOf(new Headers())).toBe("unknown");
  });
});
