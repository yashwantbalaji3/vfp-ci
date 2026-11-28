// Source clearance for researched facts (owner direction 17 Nov 2026 22:37 UTC; docs/46). Pure
// functions over the reviewed registry file (scripts/menu-access-registry.json): no I/O.
//
// A fact counts only when the latest registry entry for its source's exact host permits our use.
// No entry, "unclear" or "unreadable" is "pending"; "prohibits" is "prohibited". Fail closed.
// "private_pilot" (an owner decision, 18 Nov 2026) is its own state: facts only, private, never cleared.

/** The exact host of a web address, lower case, without a leading "www.". */
export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** host -> latest entry, from a registry file's reviews (later reviewedAt wins; ties: later in the file). */
export function registryIndex(registry) {
  const out = new Map();
  for (const r of registry?.reviews ?? []) {
    for (const h of r.hosts ?? []) {
      const host = String(h).toLowerCase().replace(/^www\./, "");
      const prev = out.get(host);
      if (!prev || +new Date(r.reviewedAt) >= +new Date(prev.reviewedAt)) out.set(host, r);
    }
  }
  return out;
}

/** cleared | private_pilot | pending | prohibited for one address. */
export function accessState(url, index, now = new Date()) {
  const r = index.get(hostOf(url) ?? "");
  if (!r) return "pending";
  if (r.status === "prohibits") return "prohibited";
  if (r.status === "private_pilot") return "private_pilot";
  if (r.status !== "permits") return "pending";
  if (r.expiresAt && +new Date(r.expiresAt) <= +now) return "pending";
  if ((r.kind ?? "terms_review") === "terms_review" && +now - +new Date(r.reviewedAt) > 180 * 864e5) return "pending";
  return "cleared";
}

const isProtein = (f) => f.kind === "published_nutrition" && !f.unknownReason && (f.subject ?? f.value?.nutrient) === "protein_g";

/**
 * One row per source of every researched place: address, how it was collected, terms status and
 * permitted uses, and how many facts (and protein figures) rest on it.
 */
export function auditSources(files, index) {
  const rows = [];
  for (const { file, entry } of files) {
    for (const p of entry.places ?? []) {
      for (const s of p.sources ?? []) {
        const facts = (p.facts ?? []).filter((f) => f.source === s.key);
        const r = index.get(hostOf(s.url) ?? "");
        rows.push({
          file, place: p.label, source: s.key, url: s.url, host: hostOf(s.url), kind: s.kind, publisher: s.publisher, retrievedAt: s.retrievedAt,
          method: /summaris/i.test(s.termsNote ?? "") ? "Claude's web-reading tool (summarising fetch), one-time" : "Claude's web-reading tool, one-time",
          state: accessState(s.url, index), termsStatus: r?.status ?? "not reviewed", termsUrl: r?.url ?? null, permittedUses: r?.uses ?? null,
          facts: facts.length, known: facts.filter((f) => !f.unknownReason).length, protein: facts.filter(isProtein).length,
        });
      }
    }
  }
  return rows;
}

/**
 * Splits a place's facts into those from cleared sources and those held back. Held facts never
 * count toward readiness, founder batches or publication.
 */
export function splitByClearance(place, index) {
  const state = Object.fromEntries((place.sources ?? []).map((s) => [s.key, accessState(s.url, index)]));
  const cleared = [], held = [];
  for (const f of place.facts ?? []) (state[f.source] === "cleared" ? cleared : held).push({ ...f, sourceState: state[f.source] ?? "pending" });
  return { cleared, held };
}

/**
 * Targeted cleanup of one entry file: removes the sources, facts and (now empty) dishes that rest on
 * prohibited hosts. Pending and cleared content is kept untouched. Returns the cleaned entry and an
 * audit of what went (counts, hosts and fingerprints only; no content).
 */
export function cleanEntry(entry, index, sha) {
  const removed = [];
  const places = (entry.places ?? []).map((p) => {
    const bad = new Set((p.sources ?? []).filter((s) => accessState(s.url, index) === "prohibited").map((s) => s.key));
    if (!bad.size) return p;
    const facts = (p.facts ?? []).filter((f) => !bad.has(f.source));
    const gone = (p.facts ?? []).filter((f) => bad.has(f.source));
    const usedDishes = new Set(facts.map((f) => f.dish).filter(Boolean));
    const dishes = (p.dishes ?? []).filter((d) => usedDishes.has(d.key));
    const lostSources = (p.sources ?? []).filter((s) => bad.has(s.key));
    removed.push({
      place: p.label,
      hosts: [...new Set(lostSources.map((s) => hostOf(s.url)))].sort(),
      sources: lostSources.map((s) => ({ urlSha256: sha(s.url), retrievedAt: s.retrievedAt })),
      facts: gone.length, protein: gone.filter(isProtein).length, dishes: (p.dishes ?? []).length - dishes.length,
    });
    const { notes, ...rest } = p;
    return {
      ...rest, sources: (p.sources ?? []).filter((s) => !bad.has(s.key)), dishes, facts,
      ...(notes && !lostSources.length ? { notes } : {}),
      sourceHold: "Facts from sources whose terms prohibit our use were removed on 2026-11-17 (owner direction 22:06/22:37 UTC); see the removal log.",
    };
  });
  if (!removed.length) return { entry, removed };
  // The file's own note may quote removed pages, so it is replaced by a neutral one (its fingerprint is logged).
  const note = "Research entries. Content from sources whose terms prohibit our use was removed on 2026-11-17 (owner direction 22:06 and 22:37 UTC; see the removal log). What remains is held until its sources are cleared (docs/46). Submitted and unverified.";
  return { entry: { ...entry, ...(entry._note ? { _note: note } : {}), places }, removed, noteSha256: entry._note ? sha(entry._note) : null };
}
