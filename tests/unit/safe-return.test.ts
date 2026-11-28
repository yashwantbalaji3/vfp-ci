import { describe, expect, it } from "vitest";
import { safeReturnPath } from "@/lib/format";

// Release audit 23 Nov 2026 (docs/75 item 1): tabs and newlines are dropped by the URL parser, so "/\t/evil.example"
// used to pass the "no //" check and resolve to another site after a genuine sign-in.
describe("safeReturnPath", () => {
  it("keeps ordinary same-site paths", () => {
    for (const p of ["/today", "/meals/abc?from=%2Fdiscover", "/places/menus#top", "/search?q=tofu%20bowl"]) expect(safeReturnPath(p)).toBe(p);
  });
  it("refuses every way out to another site", () => {
    const bad = [
      "//evil.example", "/\t/evil.example", "/\n/evil.example", "/\r/evil.example", "/\u0000/evil.example", "/\u007f/x",
      "/\\evil.example", "\\\\evil.example", "https://evil.example", "evil.example", "javascript:alert(1)", " /today", "",
    ];
    for (const p of bad) expect(safeReturnPath(p, "/fallback"), JSON.stringify(p)).toBe("/fallback");
    expect(safeReturnPath(null, "/fallback")).toBe("/fallback");
    expect(safeReturnPath(`/${"a".repeat(600)}`, "/fallback")).toBe("/fallback");
  });
  it("as decoded from a query string, the encoded forms are refused too", () => {
    for (const q of ["next=/%09/evil.example", "next=/%0a/evil.example", "next=%2F%2Fevil.example", "next=/%5Cevil.example"]) {
      expect(safeReturnPath(new URLSearchParams(q).get("next"), "/fallback"), q).toBe("/fallback");
    }
  });
});
