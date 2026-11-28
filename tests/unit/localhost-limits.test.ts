import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";

// Localhost stabilization (15 Nov 2026): a request counter that cannot be checked is still refused
// (fail closed), but it is no longer reported as "too many requests".
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({}) }));

import { recordHit } from "@/server/rate-limit";
import { limitRefusal } from "@/server/http";
import { LimitUnavailable, TooManyRequests, limitNotice } from "@/components/too-many-requests";

const saved = { ...process.env };
beforeEach(() => {
  process.env.RATE_LIMIT_SALT = "unit-test-salt-unit-test-salt";
  process.env.RATE_LIMIT_KEY = "unit-test-key-unit-test-key-unit-test-key";
});
afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
});
const db = (answer: { data?: unknown; error?: { code?: string } | null } | Error) =>
  ({
    rpc: async () => {
      if (answer instanceof Error) throw answer;
      return { data: answer.data ?? null, error: answer.error ?? null };
    },
  }) as never;

describe("limit outcomes are told apart", () => {
  it("pages: within the limit shows the results, too many shows 'Too many requests', a broken counter shows 'temporarily unavailable'", () => {
    expect(limitNotice("ok")).toBeNull();
    const limited = limitNotice("limited") as ReactElement;
    const unavailable = limitNotice("unavailable") as ReactElement;
    expect(isValidElement(limited) && limited.type).toBe(TooManyRequests);
    expect(isValidElement(unavailable) && unavailable.type).toBe(LimitUnavailable);
  });
  it("APIs: 429 with Retry-After for too many, 503 for a broken counter, nothing for ok", async () => {
    expect(limitRefusal("ok")).toBeNull();
    const limited = limitRefusal("limited")!;
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(((await limited.json()) as { error: { code: string } }).error.code).toBe("RATE_LIMITED");
    const broken = limitRefusal("unavailable")!;
    expect(broken.status).toBe(503);
    expect(((await broken.json()) as { error: { code: string } }).error.code).toBe("LIMITER_UNAVAILABLE");
  });
  it("still fails closed: an unrecognised key, a missing function, a missing setting and an unreachable database are all refused", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await recordHit(db({ error: { code: "PT403" } }), "page", "page", "a")).toBe("unavailable");
    expect(await recordHit(db({ error: { code: "PGRST202" } }), "page", "page", "a")).toBe("unavailable");
    expect(await recordHit(db(new TypeError("fetch failed")), "page", "page", "a")).toBe("unavailable");
    delete process.env.RATE_LIMIT_KEY;
    expect(await recordHit(db({ data: true }), "page", "page", "a")).toBe("unavailable");
  });
});

describe("the development log says what to fix, without values", () => {
  const logged = async (answer: Parameters<typeof db>[0], env: "development" | "production") => {
    vi.stubEnv("NODE_ENV", env);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await recordHit(db(answer), "page", "page", "203.0.113.9");
    vi.unstubAllEnvs();
    const text = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    spy.mockRestore();
    return text;
  };
  it("names the cause and the fix for each local setup fault", async () => {
    expect(await logged({ error: { code: "PT403" } }, "development")).toMatch(/does not recognise this server's RATE_LIMIT_KEY.*pnpm local:doctor/);
    expect(await logged({ error: { code: "PGRST202" } }, "development")).toMatch(/database changes are pending/);
    expect(await logged(new TypeError("fetch failed"), "development")).toMatch(/could not be reached/);
    delete process.env.RATE_LIMIT_SALT;
    expect(await logged({ data: true }, "development")).toMatch(/MISSING_SETTING.*missing from \.env\.local/);
  });
  it("never logs the key, the salt or the visitor's address, and adds no hint in production", async () => {
    const dev = await logged({ error: { code: "PT403" } }, "development");
    const prod = await logged({ error: { code: "PT403" } }, "production");
    for (const text of [dev, prod]) {
      expect(text).not.toContain("unit-test-key");
      expect(text).not.toContain("unit-test-salt");
      expect(text).not.toContain("203.0.113.9");
    }
    expect(prod).not.toMatch(/local setup/);
  });
});
