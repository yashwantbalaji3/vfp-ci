// robots.txt rules (RFC 9309), read conservatively for the menu pipeline (docs/41).
//
// A path may be read only if EVERY group that applies to us allows it: the group for our own
// product token, the groups for Anthropic's crawlers (the pipeline is run by Claude), and the
// catch-all "*" group for any token that has no group of its own. Within a group the longest
// matching rule wins, and "allow" wins a tie. Patterns support "*" and a final "$".
// Pure functions: no network, no database.

/** Product tokens whose rules we honour. The first is our own. */
export const PIPELINE_TOKENS = ["VFPMenuCheck", "ClaudeBot", "Claude-User", "anthropic-ai"];
export const PIPELINE_USER_AGENT = "VFPMenuCheck/0.1 (local, non-commercial menu research; honours robots.txt)";
export const MAX_ROBOTS_BYTES = 500 * 1024;

/**
 * @param {string} text
 * @returns {{ agents: string[], rules: { allow: boolean, pattern: string }[], crawlDelay: number | null }[]}
 */
export function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const raw of String(text ?? "").slice(0, MAX_ROBOTS_BYTES).split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) { current = { agents: [], rules: [], crawlDelay: null }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "allow" || key === "disallow") {
      if (value === "") continue; // an empty rule matches nothing
      current.rules.push({ allow: key === "allow", pattern: value });
    } else if (key === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
    }
  }
  return groups;
}

/** Does a robots pattern match the start of this path? */
export function patternMatches(pattern, path) {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = body.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${re}${anchored ? "$" : ""}`).test(path);
}

function groupsFor(groups, token) {
  const t = token.toLowerCase();
  const own = groups.filter((g) => g.agents.some((a) => a !== "*" && a === t));
  return own.length ? own : groups.filter((g) => g.agents.includes("*"));
}

function evaluate(rules, path) {
  let best = null;
  for (const r of rules) {
    if (!patternMatches(r.pattern, path)) continue;
    const len = r.pattern.replace(/\*|\$$/g, "").length;
    if (!best || len > best.len || (len === best.len && r.allow && !best.rule.allow)) best = { rule: r, len };
  }
  return best ? best.rule : null;
}

/**
 * Decide whether a path may be read.
 * @param {string} robotsText
 * @param {string} path
 * @param {string[]} [tokens]
 * @returns {{ allowed: boolean, rule: string | null, crawlDelay: number | null }}
 */
export function decide(robotsText, path, tokens = PIPELINE_TOKENS) {
  const groups = parseRobots(robotsText);
  const p = path.startsWith("/") ? path : `/${path}`;
  let crawlDelay = null;
  const used = new Set();
  for (const token of tokens) {
    const gs = groupsFor(groups, token);
    for (const g of gs) {
      if (used.has(g)) continue;
      used.add(g);
      if (g.crawlDelay != null) crawlDelay = Math.max(crawlDelay ?? 0, g.crawlDelay);
    }
    const rule = evaluate(gs.flatMap((g) => g.rules), p);
    if (rule && !rule.allow) {
      return { allowed: false, rule: `user-agent ${gs[0].agents.join(", ")}: Disallow: ${rule.pattern}`, crawlDelay };
    }
  }
  return { allowed: true, rule: null, crawlDelay };
}

/**
 * Turn a website field into a host and a start URL. Returns null for anything that is not a web address.
 * @param {string | null | undefined} website
 */
export function normaliseWebsite(website) {
  if (!website) return null;
  let s = String(website).trim();
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:(?!\/\/)/i.test(s)) return null; // mailto:, tel:, javascript: and the like
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return null;
  u.hash = "";
  for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|y_source)/i.test(k)) u.searchParams.delete(k);
  return { host, url: u.toString().slice(0, 500), path: (u.pathname || "/") + (u.search || "") };
}

/** The excluded host that covers this host (itself or a parent domain), or null. */
export function excludedBy(host, excluded) {
  for (const e of excluded) if (host === e || host.endsWith(`.${e}`)) return e;
  return null;
}
