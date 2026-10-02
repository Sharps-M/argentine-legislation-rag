import { describe, expect, it } from "vitest";

import { createPoliteFetcher, USER_AGENT } from "./fetcher";

/** A fake clock: `sleep` advances time instead of waiting. */
const fakeClock = () => {
  let time = 0;
  const sleeps: number[] = [];
  return {
    now: () => time,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      time += ms;
    },
    advance: (ms: number) => {
      time += ms;
    },
    sleeps,
  };
};

const html = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=ISO-8859-1" },
  });

describe("createPoliteFetcher", () => {
  it("identifies itself and returns the page bytes", async () => {
    const requests: { url: string; userAgent: string | null }[] = [];
    const fetchPage = createPoliteFetcher({
      ...fakeClock(),
      fetch: async (url, init) => {
        requests.push({
          url: String(url),
          userAgent: new Headers(init?.headers).get("user-agent"),
        });
        return html("<p>Ley</p>");
      },
    });

    const page = await fetchPage("http://example.test/norma.htm");

    expect(requests).toEqual([
      { url: "http://example.test/norma.htm", userAgent: USER_AGENT },
    ]);
    expect(USER_AGENT).toMatch(/^NormativaAR\/.+\(\+https:\/\/github\.com\/.+\)$/);
    expect(page).toMatchObject({
      ok: true,
      contentType: "text/html; charset=ISO-8859-1",
    });
    expect(page.ok && new TextDecoder().decode(page.bytes)).toBe("<p>Ley</p>");
  });

  it("waits between requests, counting the time already elapsed", async () => {
    const clock = fakeClock();
    const fetchPage = createPoliteFetcher({
      ...clock,
      delayMs: 1000,
      fetch: async () => html("ok"),
    });

    await fetchPage("http://example.test/1");
    await fetchPage("http://example.test/2");
    clock.advance(400);
    await fetchPage("http://example.test/3");
    clock.advance(5000);
    await fetchPage("http://example.test/4");

    expect(clock.sleeps).toEqual([1000, 600]);
  });

  it("retries server errors with backoff and then succeeds", async () => {
    const clock = fakeClock();
    const responses = [html("", 503), html("", 500), html("al fin")];
    const fetchPage = createPoliteFetcher({
      ...clock,
      delayMs: 100,
      fetch: async () => responses.shift()!,
    });

    const page = await fetchPage("http://example.test/norma.htm");

    expect(page.ok).toBe(true);
    expect(responses).toHaveLength(0);
    expect(clock.sleeps).toEqual([200, 400]);
  });

  it.each([403, 404])("does not retry a %i", async (status) => {
    let calls = 0;
    const fetchPage = createPoliteFetcher({
      ...fakeClock(),
      fetch: async () => {
        calls += 1;
        return html("", status);
      },
    });

    await expect(fetchPage("http://example.test/norma.htm")).resolves.toEqual({
      ok: false,
      status,
      reason: `HTTP ${status}`,
    });
    expect(calls).toBe(1);
  });

  it("gives up after the configured retries and reports the last error", async () => {
    let calls = 0;
    const fetchPage = createPoliteFetcher({
      ...fakeClock(),
      retries: 2,
      fetch: async () => {
        calls += 1;
        throw new Error("socket hang up");
      },
    });

    await expect(fetchPage("http://example.test/norma.htm")).resolves.toEqual({
      ok: false,
      status: null,
      reason: "socket hang up",
    });
    expect(calls).toBe(3);
  });
});
