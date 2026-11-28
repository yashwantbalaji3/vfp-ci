import { describe, expect, it } from "vitest";
import { decide, excludedBy, normaliseWebsite, parseRobots, patternMatches } from "../../scripts/lib/robots.mjs";
import { decisionFor } from "../../scripts/menu-sources.mjs";

// Menu pipeline access rules (docs/41). Robots files here are invented examples.

describe("robots.txt rules", () => {
  it("groups consecutive user-agent lines and ignores comments and unknown lines", () => {
    const g = parseRobots("# hi\nUser-agent: A\nUser-agent: B\nDisallow: /x # no\nSitemap: https://e.test/s.xml\n\nUser-agent: *\nAllow: /\nCrawl-delay: 5\n");
    expect(g).toEqual([
      { agents: ["a", "b"], rules: [{ allow: false, pattern: "/x" }], crawlDelay: null },
      { agents: ["*"], rules: [{ allow: true, pattern: "/" }], crawlDelay: 5 },
    ]);
  });

  it("matches wildcards and an end anchor", () => {
    expect(patternMatches("/menu", "/menu/lunch")).toBe(true);
    expect(patternMatches("/*.pdf$", "/files/nutrition.pdf")).toBe(true);
    expect(patternMatches("/*.pdf$", "/files/nutrition.pdf?x=1")).toBe(false);
    expect(patternMatches("/a*c", "/abbbc/d")).toBe(true);
    expect(patternMatches("/menu.", "/menuX")).toBe(false);
  });

  it("the longest rule wins, and allow wins a tie", () => {
    const t = "User-agent: *\nDisallow: /menu\nAllow: /menu/public\nAllow: /x\nDisallow: /x\n";
    expect(decide(t, "/menu/secret").allowed).toBe(false);
    expect(decide(t, "/menu/public/today").allowed).toBe(true);
    expect(decide(t, "/x").allowed).toBe(true);
  });

  it("an empty Disallow allows everything; no file content allows everything", () => {
    expect(decide("User-agent: *\nDisallow:\n", "/menu").allowed).toBe(true);
    expect(decide("", "/").allowed).toBe(true);
  });

  it("honours Anthropic's crawler groups as well as the catch-all", () => {
    const t = "User-agent: ClaudeBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n";
    const d = decide(t, "/menu");
    expect(d.allowed).toBe(false);
    expect(d.rule).toBe("user-agent claudebot: Disallow: /");
    expect(decide("User-agent: anthropic-ai\nDisallow: /menu\n", "/menu/a").allowed).toBe(false);
    expect(decide("User-agent: GPTBot\nDisallow: /\n", "/menu").allowed).toBe(true);
  });

  it("the catch-all applies to our own token, and a disallowed catch-all blocks us", () => {
    expect(decide("User-agent: *\nDisallow: /\n", "/").allowed).toBe(false);
  });

  it("records the largest crawl delay that applies", () => {
    expect(decide("User-agent: *\nCrawl-delay: 10\n", "/").crawlDelay).toBe(10);
  });
});

describe("answers from a website", () => {
  it("a missing robots.txt means no rules; refusals, errors and no answer mean not allowed", () => {
    expect(decisionFor({ status: 404, text: "" }, "/").decision).toBe("allowed");
    expect(decisionFor({ status: 403, text: "" }, "/").decision).toBe("unreachable");
    expect(decisionFor({ status: 401, text: "" }, "/").decision).toBe("unreachable");
    expect(decisionFor({ status: 429, text: "" }, "/").decision).toBe("unreachable");
    expect(decisionFor({ status: 503, text: "" }, "/").decision).toBe("unreachable");
    expect(decisionFor({ status: null, text: null, error: "timeout" }, "/")).toMatchObject({ decision: "unreachable", note: "No answer: timeout" });
    expect(decisionFor({ status: 200, text: "User-agent: *\nDisallow: /\n" }, "/")).toMatchObject({ decision: "disallowed", rule: "user-agent *: Disallow: /" });
    expect(decisionFor({ status: 200, text: "User-agent: *\nCrawl-delay: 3\n" }, "/")).toMatchObject({ decision: "allowed", note: "Crawl-delay 3s" });
  });
});

describe("website addresses", () => {
  it("normalises hosts and drops tracking parameters", () => {
    expect(normaliseWebsite("www.Example-Cafe.com/menu?utm_source=x&id=2#top")).toEqual({ host: "example-cafe.com", url: "https://www.example-cafe.com/menu?id=2", path: "/menu?id=2" });
    expect(normaliseWebsite("http://locations.chain.test/ma/boston/1")).toMatchObject({ host: "locations.chain.test", path: "/ma/boston/1" });
  });
  it("refuses anything that is not a web address", () => {
    for (const w of ["", null, "mailto:a@b.test", "ftp://x.test", "not a site", "javascript:alert(1)"]) expect(normaliseWebsite(w)).toBeNull();
  });
  it("an excluded host covers its subdomains, not look-alikes", () => {
    const ex = ["yelp.com", "toasttab.com"];
    expect(excludedBy("yelp.com", ex)).toBe("yelp.com");
    expect(excludedBy("order.toasttab.com", ex)).toBe("toasttab.com");
    expect(excludedBy("notyelp.com", ex)).toBeNull();
  });
});
