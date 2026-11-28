// Founder review of staged pilot facts: data loading, page rendering and decisions.
// Used by scripts/pilot-review.mjs (the local review page) and by tests/db/pilot-review.test.ts.
import { createServer } from "node:http";

// All text from the web (labels, URLs, notes) is escaped before it is put into the page.

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const safeHref = (url) => (/^https:\/\/[^\s"'<>]+$/.test(url ?? "") ? esc(url) : null);

const KIND_WORDS = {
  address: "Address",
  operating_status: "Open or closed",
  weekly_hours: "Opening hours",
  menu_item: "On the menu",
  price: "Price",
  dietary_status: "Dietary status",
  allergen_statement: "Allergens",
  published_nutrition: "Nutrition figure",
  serving_size: "Serving size",
};
/**
 * What is being verified, in review order (owner 23:11 UTC 16 Nov: identity, operating status,
 * dishes, dietary status, nutrition, allergens, prices and serving information are verified
 * separately; a missing nutrition figure never holds back the others).
 */
export const FACT_GROUPS = [
  { key: "identity", label: "Identity and location", kinds: ["address"] },
  { key: "status", label: "Operating status and hours", kinds: ["operating_status", "weekly_hours"] },
  { key: "dishes", label: "Dishes on the menu", kinds: ["menu_item"] },
  { key: "dietary", label: "Dietary status", kinds: ["dietary_status"] },
  { key: "nutrition", label: "Nutrition", kinds: ["published_nutrition"] },
  { key: "serving", label: "Serving information", kinds: ["serving_size"] },
  { key: "allergens", label: "Allergens", kinds: ["allergen_statement"] },
  { key: "prices", label: "Prices", kinds: ["price"] },
];

const CLAIM_WORDS = { vegan: "Vegan", vegetarian: "Vegetarian", egg_free: "Egg-free" };
const NUTRIENT_WORDS = { protein_g: ["Protein", "g"], energy_kcal: ["Energy", "kcal"], fat_g: ["Fat", "g"], carb_g: ["Carbohydrate", "g"], fiber_g: ["Fibre", "g"], sodium_mg: ["Sodium", "mg"] };
const SOURCE_WORDS = { restaurant_site: "Restaurant's own website", restaurant_ordering: "Restaurant's own ordering page", restaurant_nutrition_guide: "Restaurant's own nutrition guide", news: "News article", government_dataset: "Government dataset", directory: "Directory listing" };
// The four nutrition states, in the owner's words (23:21 UTC). Only the first can come from staging today.
export const NUTRITION_STATE_WORDS = {
  restaurant_published: "Restaurant-published figure",
  calculated: "Calculated from verified ingredients and portions",
  estimated: "Estimated range (not exact)",
  unknown: "Unknown",
};

/** Plain words for one fact's value, e.g. "Vegan: no", "Protein 44 g per serving", "Unknown: reason". */
export function describeValue(f) {
  const what = f.kind === "dietary_status" ? CLAIM_WORDS[f.subject] ?? f.subject
    : f.kind === "published_nutrition" ? (NUTRIENT_WORDS[f.subject]?.[0] ?? f.subject) : null;
  if (f.is_unknown) return `${what ? `${what}: ` : ""}Unknown. ${f.unknown_reason}`;
  const v = f.value ?? {};
  switch (f.kind) {
    case "address": return `${v.street}, ${v.postcode}`;
    case "operating_status": return { operating: "Operating", closed: "Closed", temporarily_closed: "Temporarily closed" }[v.status] ?? v.status;
    case "weekly_hours": return (v.periods ?? []).map((p) => `${p.days} ${p.open}–${p.close}`).join("; ") || "No periods";
    case "menu_item": return v.listed ? "Listed on the current menu" : "Not on the current menu";
    case "price": return `$${v.usd}`;
    case "dietary_status": {
      // Owner 22:26 UTC 16 Nov: a restaurant legend such as "VG = Vegetarian & Vegan-Friendly" is
      // preliminary evidence only. Show the exact label, where it came from and every flag, so the
      // founder checks the dish rather than the label.
      if (v.evidence !== "preliminary_label") return `${what}: ${v.status}`;
      const flags = (v.reviewFlags ?? []).map((f) => ` CHECK: ${f}`).join("");
      return `${what}: ${v.status} (preliminary: the restaurant marks it "${v.label}", defined as "${v.labelWording}" at ${v.labelSource}; not a verified ${what.toLowerCase()} statement).${flags}`;
    }
    case "allergen_statement": return `${{ contains: "Contains", may_contain: "May contain", free_from: "Free from" }[v.statement]} ${(v.allergens ?? []).join(", ").replace(/_/g, " ")}${v.printed ? ` (printed: "${v.printed}")` : ""}`;
    case "published_nutrition": {
      const [, unit] = NUTRIENT_WORDS[v.nutrient] ?? ["", ""];
      return `${what} ${v.amount} ${unit} per ${v.per === "100g" ? "100 g" : "serving"}`;
    }
    case "serving_size": return `${v.grams} g`;
    default: return JSON.stringify(v);
  }
}

/** Everything waiting for review, grouped by place, then dish (place-level facts first). */
export async function loadQueue(client) {
  const rows = (await client.query("select * from staging.review_queue()")).rows;
  const places = new Map();
  for (const r of rows) {
    if (!places.has(r.place_id)) places.set(r.place_id, { id: r.place_id, label: r.place_label, area: r.area, priority: r.shortlist_priority, groups: new Map() });
    const p = places.get(r.place_id);
    const key = r.dish_id ?? "place";
    if (!p.groups.has(key)) p.groups.set(key, { dishId: r.dish_id, label: r.dish_label ?? "The place itself", facts: [] });
    p.groups.get(key).facts.push(r);
  }
  return [...places.values()].map((p) => ({ ...p, groups: [...p.groups.values()] }));
}

/** One decision, recorded by the database with the two-person rule. Returns "verified" or "rejected". */
export async function decide(client, actorId, factId, decision, note, { nested = false } = {}) {
  // `nested`: the caller already holds an open transaction (the tests do), so a refused decision is
  // rolled back to a savepoint instead of aborting the caller's whole transaction.
  if (nested) await client.query("savepoint pilot_review_decide");
  try {
    const r = await client.query("select staging.review_fact($1, $2, $3, $4) as r", [actorId, factId, decision, note || null]);
    if (nested) await client.query("release savepoint pilot_review_decide");
    return r.rows[0].r;
  } catch (e) {
    if (nested) await client.query("rollback to savepoint pilot_review_decide");
    throw e;
  }
}

const area = (a) =>
  ({
    central_square: "Central Square", harvard_square: "Harvard Square", back_bay: "Back Bay", fenway_kenmore: "Fenway–Kenmore",
    south_end: "South End", downtown: "Downtown", chinatown: "Chinatown", beacon_hill: "Beacon Hill", longwood: "Longwood",
  })[a] ?? a;
const date = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d ?? "").slice(0, 10));

function factCard(f, token, reviewerId, dishLabel = null) {
  const href = safeHref(f.source_url);
  const own = f.entered_by === reviewerId;
  const state = f.nutrition_state ? `<p class="state" data-state="${esc(f.nutrition_state)}">${esc(NUTRITION_STATE_WORDS[f.nutrition_state])}</p>` : "";
  const change = f.replaces_value !== null && f.replaces_value !== undefined || f.replaces_unknown
    ? `<p class="change">Replaces a verified fact: ${esc(describeValue({ ...f, value: f.replaces_value, is_unknown: f.replaces_unknown, unknown_reason: "(was unknown)" }))}</p>` : "";
  return `<article class="fact${f.is_unknown ? " unknown" : ""}" data-fact="${esc(f.fact_id)}">
  <h4>${dishLabel ? `${esc(dishLabel)} · ` : ""}${esc(KIND_WORDS[f.kind] ?? f.kind)}</h4>
  <p class="value">${esc(describeValue(f))}</p>
  ${state}${change}
  <dl>
    <dt>Source</dt><dd>${href ? `<a href="${href}" rel="noopener noreferrer" target="_blank">${esc(f.source_url)}</a>` : esc(f.source_url)} <span class="kind">${esc(SOURCE_WORDS[f.source_kind] ?? f.source_kind)}</span></dd>
    <dt>Source read</dt><dd>${esc(date(f.source_retrieved_at))}</dd>
    <dt>Checked on</dt><dd>${esc(date(f.checked_on))}</dd>
    <dt>Entered by</dt><dd>${esc(f.entered_by_email ?? f.entered_by)}</dd>
    ${f.source_terms_note ? `<dt>Rights note</dt><dd>${esc(f.source_terms_note)}</dd>` : ""}
  </dl>
  ${own ? `<p class="own">You entered this fact, so a different person must check it.</p>` : `<form method="post" action="/decide">
    <input type="hidden" name="token" value="${esc(token)}"><input type="hidden" name="fact" value="${esc(f.fact_id)}">
    <label>Note (optional) <input name="note" maxlength="500"></label>
    <button name="decision" value="verify">Verify</button>
    <button name="decision" value="reject">Reject</button>
  </form>`}
</article>`;
}

/** The whole review page. `reviewer` is {id, email}. `flash` is a short message after a decision. */
/**
 * @param {any[]} fullQueue
 * @param {{ token: string, reviewer: { id: string, email: string }, flash?: string | null, batch?: string[] | null }} options
 */
export function renderPage(fullQueue, { token, reviewer, flash, batch = null }) {
  // A batch is a short list of place labels: only those places are shown, so a review session is a
  // manageable set of related facts rather than the whole queue.
  const queue = batch ? fullQueue.filter((p) => batch.includes(p.label)) : fullQueue;
  const total = queue.reduce((n, p) => n + p.groups.reduce((m, g) => m + g.facts.length, 0), 0);
  // Within a place, facts are grouped by what is being verified, each card naming its dish.
  const byType = (p) => FACT_GROUPS.map((t) => ({
    ...t,
    facts: p.groups.flatMap((g) => g.facts.filter((f) => t.kinds.includes(f.kind)).map((f) => ({ f, dish: g.dishId ? g.label : null }))),
  })).filter((t) => t.facts.length);
  const summary = queue.map((p) => `<li><a href="#p-${esc(p.id)}">${esc(p.label)}</a>: ${byType(p).map((t) => `${esc(t.label)} ${t.facts.length}`).join(" · ")}</li>`).join("");
  const body = queue.map((p) => `<section class="place" id="p-${esc(p.id)}"><h2>${esc(p.label)} <small>${esc(area(p.area))} · priority ${esc(p.priority)}</small></h2>
${byType(p).map((t) => `<div class="group" data-group="${esc(t.key)}"><h3>${esc(t.label)}</h3>${t.facts.map(({ f, dish }) => factCard(f, token, reviewer.id, dish)).join("\n")}</div>`).join("\n")}
</section>`).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pilot review</title>
<style>
:root{--bg:#fbf8f2;--ink:#1f2a24;--muted:#5b665f;--line:#ddd5c8;--card:#fff;--accent:#2f6b4f;--warn:#8a4b0f}
@media (prefers-color-scheme:dark){:root{--bg:#141815;--ink:#e9efe9;--muted:#a3ada6;--line:#2e3631;--card:#1b201c;--accent:#7fc4a0;--warn:#f0b27a}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:16px}
h1{font-size:1.5rem;margin:.5rem 0} h2{font-size:1.25rem;margin:1.5rem 0 .5rem} h2 small{color:var(--muted);font-weight:400;font-size:.9rem}
h3{font-size:1rem;margin:1rem 0 .5rem;color:var(--muted)} h4{margin:0 0 .25rem;font-size:.95rem}
.fact{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;margin:0 0 10px}
.fact.unknown{border-style:dashed} .value{font-size:1.05rem;margin:.25rem 0} .state{color:var(--accent);margin:.25rem 0;font-weight:600}
.change{color:var(--warn)} dl{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px;margin:.5rem 0;font-size:.9rem} dt{color:var(--muted)} dd{margin:0;overflow-wrap:anywhere}
.kind{color:var(--muted)} form{display:flex;flex-wrap:wrap;gap:8px;align-items:center} label{flex:1 1 220px;display:flex;flex-direction:column;font-size:.85rem;color:var(--muted)}
input[name=note]{font:inherit;padding:6px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--ink)}
button{font:inherit;padding:8px 16px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:var(--bg);cursor:pointer;min-height:44px}
button[value=reject]{background:transparent;color:var(--ink);border-color:var(--line)} .own{color:var(--muted);font-style:italic}
.flash{background:var(--card);border-left:4px solid var(--accent);padding:8px 12px}
</style></head><body><main>
<h1>Pilot facts waiting for your review</h1>
<p>Signed in locally as ${esc(reviewer.email)}. ${total} fact${total === 1 ? "" : "s"} waiting. Nothing here is public; verifying a fact does not publish it.</p>
${batch ? `<p>Batch: ${queue.length} of ${fullQueue.length} places waiting. Each fact is still verified on its own.</p>` : ""}
${flash ? `<p class="flash" role="status">${esc(flash)}</p>` : ""}
${total ? `<nav aria-label="Places in this review"><ul>${summary}</ul></nav>` : ""}
${total ? body : "<p>Nothing is waiting for review.</p>"}
</main></body></html>`;
}

const HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'", "referrer-policy": "no-referrer" };
const FLASH = { STAGING_SAME_PERSON: "You entered this fact, so a different person must check it.", STAGING_ALREADY_REVIEWED: "That fact was already reviewed.", STAGING_ROLE_REQUIRED: "Your account does not have the publisher role." };

/**
 * The local review web server. `db` has a pg-style query(); `reviewer` is {id, email}; `token` is a
 * random secret that every decision must carry (so another site cannot submit the form).
 * Only requests addressed to 127.0.0.1 or localhost are answered.
 */
/** @param {{ db: any, reviewer: { id: string, email: string }, token: string, nested?: boolean, batch?: string[] | null }} options */
export function createReviewServer({ db, reviewer, token, nested = false, batch = null }) {
  const send = (res, status, html) => { res.writeHead(status, HEADERS); res.end(html); };
  return createServer(async (req, res) => {
    try {
      const host = (req.headers.host ?? "").split(":")[0];
      if (host !== "127.0.0.1" && host !== "localhost") return send(res, 403, "Local only");
      const u = new URL(req.url, "http://127.0.0.1");
      if (req.method === "GET" && u.pathname === "/") {
        return send(res, 200, renderPage(await loadQueue(db), { token, reviewer, flash: u.searchParams.get("done"), batch }));
      }
      if (req.method === "POST" && u.pathname === "/decide") {
        let body = "";
        for await (const chunk of req) { body += chunk; if (body.length > 10_000) return send(res, 413, "Too large"); }
        const form = new URLSearchParams(body);
        if (form.get("token") !== token) return send(res, 403, "This page is out of date. Reload it and try again.");
        const decision = form.get("decision");
        if (!["verify", "reject"].includes(decision)) return send(res, 400, "Unknown decision");
        let flash;
        try {
          flash = `Fact ${await decide(db, reviewer.id, form.get("fact"), decision, form.get("note"), { nested })}.`;
        } catch (e) {
          flash = FLASH[e.message] ?? `Not recorded: ${e.message}`;
        }
        res.writeHead(303, { location: `/?done=${encodeURIComponent(flash)}` });
        return res.end();
      }
      send(res, 404, "Not found");
    } catch (e) {
      send(res, 500, `Error: ${esc(e.message)}`);
    }
  });
}
