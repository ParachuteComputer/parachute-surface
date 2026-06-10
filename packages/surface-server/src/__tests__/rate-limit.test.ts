import { describe, expect, test } from "bun:test";
import { RateLimiter, rateLimitedResponse } from "../auth/rate-limit.ts";

describe("RateLimiter", () => {
  test("allows under max, refuses over, resets after the window", () => {
    let now = 0;
    const limiter = new RateLimiter({ windowMs: 1000, max: 3, now: () => now });
    expect(limiter.check("ip-1").allowed).toBe(true);
    expect(limiter.check("ip-1").allowed).toBe(true);
    expect(limiter.check("ip-1").allowed).toBe(true);
    const refused = limiter.check("ip-1");
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    now = 1001;
    expect(limiter.check("ip-1").allowed).toBe(true);
  });

  test("keys are independent", () => {
    const limiter = new RateLimiter({ windowMs: 1000, max: 1, now: () => 0 });
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("b").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(false);
  });

  test("keyFor: null clientIp shares a per-layer collective bucket (limited, never unlimited)", () => {
    expect(RateLimiter.keyFor(null, "public")).toBe("anon:public");
    expect(RateLimiter.keyFor(null, "loopback")).toBe("anon:loopback");
    expect(RateLimiter.keyFor("1.2.3.4", "public")).toBe("1.2.3.4");

    const limiter = new RateLimiter({ windowMs: 1000, max: 2, now: () => 0 });
    const key = RateLimiter.keyFor(null, "public");
    expect(limiter.check(key).allowed).toBe(true);
    expect(limiter.check(key).allowed).toBe(true);
    // Third unattributed public request — collectively limited.
    expect(limiter.check(key).allowed).toBe(false);
  });

  test("table exhaustion refuses unseen keys (fail-closed), keeps live ones", () => {
    let now = 0;
    const limiter = new RateLimiter({ windowMs: 1000, max: 5, maxKeys: 2, now: () => now });
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("b").allowed).toBe(true);
    // Table full of LIVE windows → new key refused outright.
    expect(limiter.check("c").allowed).toBe(false);
    // Existing keys keep working.
    expect(limiter.check("a").allowed).toBe(true);
    // After the window lapses, pruning frees slots for new keys.
    now = 1001;
    expect(limiter.check("c").allowed).toBe(true);
  });

  test("rateLimitedResponse: 429 + Retry-After", async () => {
    const res = rateLimitedResponse({ allowed: false, retryAfterSeconds: 7 });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("7");
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("rate_limited");
  });
});
