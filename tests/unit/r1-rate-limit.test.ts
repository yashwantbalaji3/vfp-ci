import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The limiter's own rules (docs/14 PH-01 tests 2, 3, 4 and 6). The database side is in
// tests/db/r1-hardening.test.ts and the real requests in tests/e2e/r1-hardening.spec.ts.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({}) }));

import { LIMITS, bucketFor, clientAddress, recordHit, retryAfterSeconds } from "@/server/rate-limit";

const saved = { ...process.env };
beforeEach(() => {
  process.env.RATE_LIMIT_SALT = "unit-test-salt-unit-test-salt";
  process.env.RATE_LIMIT_KEY = "unit-test-key-unit-test-key-unit-test-key";
  delete process.env.TRUSTED_ADDRESS_HEADER;
  delete process.env.SIGNIN_LIMIT_SCALE;
});
afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
});
const h = (init: Record<string, string>) => new Headers(init);
type Call = { p_proof: string; p_bucket: string; p_limit: number; p_window_seconds: number };
const fakeDb = (answer: { data?: unknown; error?: { code?: string } | null } | Error) => {
  const calls: Call[] = [];
  const client = {
    rpc: async (_name: string, args: Call) => {
      calls.push(args);
      if (answer instanceof Error) throw answer;
      return { data: answer.data ?? null, error: answer.error ?? null };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, calls };
};

describe("whose address counts", () => {
  it("uses only the one header the host is configured to guarantee", () => {
    process.env.TRUSTED_ADDRESS_HEADER = "x-real-ip";
    expect(clientAddress(h({ "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9");
  });
  it("ignores a forged x-forwarded-for when another header is the trusted one, so forging earns no fresh allowance", () => {
    process.env.TRUSTED_ADDRESS_HEADER = "x-real-ip";
    const honest = clientAddress(h({ "x-real-ip": "203.0.113.9" }));
    for (const forged of ["1.2.3.4", "9.9.9.9, 10.0.0.1", "unknown"]) {
      expect(clientAddress(h({ "x-real-ip": "203.0.113.9", "x-forwarded-for": forged }))).toBe(honest);
    }
  });
  it("puts every caller in one shared allowance when no trusted header is configured", () => {
    expect(clientAddress(h({ "x-forwarded-for": "1.2.3.4", "x-real-ip": "5.6.7.8" }))).toBe("unknown");
    process.env.TRUSTED_ADDRESS_HEADER = "x-made-up-header";
    expect(clientAddress(h({ "x-made-up-header": "1.2.3.4" }))).toBe("unknown");
  });
  it("treats a missing or oversized value as unknown rather than trusting it", () => {
    process.env.TRUSTED_ADDRESS_HEADER = "x-forwarded-for";
    expect(clientAddress(h({}))).toBe("unknown");
    expect(clientAddress(h({ "x-forwarded-for": "9".repeat(200) }))).toBe("unknown");
    expect(clientAddress(h({ "x-forwarded-for": "198.51.100.7, 10.0.0.1" }))).toBe("198.51.100.7");
  });
});

describe("what is stored", () => {
  it("is a keyed hash: the address or email never appears in the bucket", () => {
    const bucket = bucketFor("page", "203.0.113.9");
    expect(bucket).toMatch(/^page:[0-9a-f]{40}$/);
    expect(bucket).not.toContain("203");
    expect(bucketFor("signInEmail", "maya@example.test")).not.toMatch(/maya|example/);
    // Every limit's bucket has the shape the database accepts (lowercase scope, colon, hash).
    for (const name of Object.keys(LIMITS)) expect(bucketFor(name, "x"), name).toMatch(/^[a-z0-9_]{3,40}:[0-9a-f]{40}$/);
  });
  it("is the same for the same visitor, different for another visitor, scope or salt", () => {
    const a = bucketFor("page", "203.0.113.9");
    expect(bucketFor("page", "203.0.113.9")).toBe(a);
    expect(bucketFor("page", "203.0.113.10")).not.toBe(a);
    expect(bucketFor("catalog", "203.0.113.9").split(":")[1]).toBe(a.split(":")[1]);
    process.env.RATE_LIMIT_SALT = "another-salt-another-salt";
    expect(bucketFor("page", "203.0.113.9")).not.toBe(a);
  });
  it("refuses to work without a salt", () => {
    delete process.env.RATE_LIMIT_SALT;
    expect(() => bucketFor("page", "x")).toThrow(/RATE_LIMIT_SALT/);
  });
});

describe("limits exist for every surface PH-01 names", () => {
  it("covers catalog, pages, sign-in per address and per email, corrections, saves, social and private routes", () => {
    for (const name of ["catalog", "page", "signInAddress", "signInEmail", "correction", "save", "memberAction", "socialRead", "socialWrite", "member"] as const) {
      expect(LIMITS[name].limit, name).toBeGreaterThan(0);
      expect(LIMITS[name].windowSeconds, name).toBeGreaterThanOrEqual(60);
      expect(retryAfterSeconds(name)).toBe(LIMITS[name].windowSeconds);
    }
    expect(LIMITS.catalog).toEqual({ limit: 60, windowSeconds: 60 });
    expect(LIMITS.signInEmail.limit).toBeLessThanOrEqual(LIMITS.signInAddress.limit);
  });
});

describe("recording a hit", () => {
  it("sends the server's proof, the hashed bucket and the limit", async () => {
    const db = fakeDb({ data: true });
    expect(await recordHit(db.client, "catalog", "catalog", "203.0.113.9")).toBe("ok");
    expect(db.calls).toEqual([{ p_proof: process.env.RATE_LIMIT_KEY, p_bucket: bucketFor("catalog", "203.0.113.9"), p_limit: 60, p_window_seconds: 60 }]);
  });
  it("reports 'limited' when the database says the allowance is used up", async () => {
    expect(await recordHit(fakeDb({ data: false }).client, "catalog", "catalog", "a")).toBe("limited");
  });
  it("fails closed: a database error, a thrown fault or a missing key all refuse the request", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await recordHit(fakeDb({ error: { code: "PT403" } }).client, "catalog", "catalog", "a")).toBe("unavailable");
    expect(await recordHit(fakeDb(new Error("network down")).client, "catalog", "catalog", "a")).toBe("unavailable");
    delete process.env.RATE_LIMIT_KEY;
    const db = fakeDb({ data: true });
    expect(await recordHit(db.client, "catalog", "catalog", "a")).toBe("unavailable");
    expect(db.calls).toEqual([]);
  });
  it("never writes the address, the email or the key to the log when it fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await recordHit(fakeDb(new Error("could not reach 203.0.113.9 for maya@example.test")).client, "signInEmail", "signInEmail", "maya@example.test");
    const written = JSON.stringify(log.mock.calls);
    expect(written).not.toMatch(/203\.0\.113\.9|maya|unit-test-key/);
  });
  it("applies the strict sign-in limits unless the local test setting relaxes them, and never relaxes anything else", async () => {
    const strict = fakeDb({ data: true });
    await recordHit(strict.client, "signInEmail", "signInEmail", "a@example.test");
    expect(strict.calls[0].p_limit).toBe(LIMITS.signInEmail.limit);
    process.env.SIGNIN_LIMIT_SCALE = "200";
    const relaxed = fakeDb({ data: true });
    await recordHit(relaxed.client, "signInEmail", "signInEmail", "a@example.test");
    await recordHit(relaxed.client, "catalog", "catalog", "a");
    await recordHit(relaxed.client, "page", "page", "a");
    expect(relaxed.calls.map((c) => c.p_limit)).toEqual([LIMITS.signInEmail.limit * 200, 60, 300]);
    process.env.SIGNIN_LIMIT_SCALE = "-5";
    const bad = fakeDb({ data: true });
    await recordHit(bad.client, "signInAddress", "signInAddress", "a");
    expect(bad.calls[0].p_limit).toBe(LIMITS.signInAddress.limit);
  });
});
