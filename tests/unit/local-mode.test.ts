import { describe, expect, it } from "vitest";
import { modeOf, withMode } from "../../scripts/local-mode.mjs";

// The reversible real-directory setting for a local Mac (R-CAT, docs/50): only two lines change.

const BASE = ["# Generated", "NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321", "ALLOW_DEMO_CONTENT=true", "REAL_CATALOG_PREVIEW=true", "RATE_LIMIT_SALT=abc", ""].join("\n");

describe("local mode", () => {
  it("reads the generated file as demo mode", () => {
    expect(modeOf(BASE)).toBe("demo");
  });

  it("switches to real and back, changing only the two settings", () => {
    const real = withMode(BASE, "real");
    expect(modeOf(real)).toBe("real");
    expect(real).toContain("ALLOW_DEMO_CONTENT=false");
    expect(real).toContain("REAL_DISCOVERY=true");
    const keep = (t: string) => t.split("\n").filter((l) => !/^(ALLOW_DEMO_CONTENT|REAL_DISCOVERY)=/.test(l));
    expect(keep(real)).toEqual(keep(BASE));
    const back = withMode(real, "demo");
    expect(modeOf(back)).toBe("demo");
    expect(keep(back)).toEqual(keep(BASE));
    expect(withMode(back, "demo")).toBe(back);
  });

  it("calls anything else mixed and refuses an unknown mode", () => {
    expect(modeOf("ALLOW_DEMO_CONTENT=true\nREAL_DISCOVERY=true\n")).toBe("mixed");
    expect(() => withMode(BASE, "public")).toThrow();
  });
});
