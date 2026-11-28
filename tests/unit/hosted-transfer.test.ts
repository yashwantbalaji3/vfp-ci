import { describe, expect, it } from "vitest";
import { assertTarget, classifyTarget as classifyRaw } from "../../scripts/lib/db-target.mjs";
import { describe as describeDb, planTransfer, stable as stableKey, summarise } from "../../scripts/lib/review-transfer-lib.mjs";

// Hosted import and review transfer (owner direction 25 Nov 2026 21:53 UTC). Synthetic values only: the project ids,
// restaurants, dishes and pages below are invented.

const REF = "abcdefghijklmnopqrst";
const env = { VFP_HOSTED_REF: REF };
const classifyTarget = (url: string, e: Record<string, string>) => classifyRaw(url, e as unknown as NodeJS.ProcessEnv);

describe("which database a data script may write to", () => {
  it("treats this computer's database as local, whatever VFP_HOSTED_REF says", () => {
    expect(classifyTarget("postgresql://postgres:postgres@127.0.0.1:54322/postgres", env).kind).toBe("local");
    expect(classifyTarget("postgresql://postgres:x@localhost:5432/postgres", {}).kind).toBe("local");
  });
  it("refuses a remote database unless the named project owns the address", () => {
    expect(classifyTarget(`postgresql://postgres:x@db.${REF}.supabase.co:5432/postgres`, {}).kind).toBe("refused");
    expect(classifyTarget(`postgresql://postgres:x@db.${REF}.supabase.co:5432/postgres`, { VFP_HOSTED_REF: "short" }).kind).toBe("refused");
    expect(classifyTarget("postgresql://postgres:x@db.zzzzzzzzzzzzzzzzzzzz.supabase.co:5432/postgres", env).kind).toBe("refused");
    expect(classifyTarget(`postgresql://postgres:x@db.${REF}.supabase.co.evil.example:5432/postgres`, env).kind).toBe("refused");
    expect(classifyTarget(`postgresql://postgres.zzzzzzzzzzzzzzzzzzzz:x@aws-0-us-east-1.pooler.supabase.com:6543/postgres`, env).kind).toBe("refused");
    expect(classifyTarget("postgresql://postgres:x@10.0.0.5:5432/postgres", env).kind).toBe("refused");
  });
  it("accepts the project's direct and pooled addresses", () => {
    expect(classifyTarget(`postgresql://postgres:x@db.${REF}.supabase.co:5432/postgres`, env)).toEqual({ kind: "hosted", ref: REF });
    expect(classifyTarget(`postgresql://postgres.${REF}:x@aws-0-us-east-1.pooler.supabase.com:6543/postgres`, env)).toEqual({ kind: "hosted", ref: REF });
  });
  it("allows on a hosted database only the commands a script lists, and never prints the password", () => {
    const prev = process.env.VFP_HOSTED_REF;
    process.env.VFP_HOSTED_REF = REF;
    try {
      const u = `postgresql://postgres:s3cret@db.${REF}.supabase.co:5432/postgres`;
      expect(assertTarget(u, "load", ["load"]).kind).toBe("hosted");
      expect(() => assertTarget(u, "publish", ["load"])).toThrow(/runs only against a local database/);
      expect(() => assertTarget(u, "load")).toThrow(/none/);
      try { assertTarget(u, "publish", ["load"]); } catch (e) { expect(String(e)).not.toContain("s3cret"); }
    } finally {
      if (prev === undefined) delete process.env.VFP_HOSTED_REF;
      else process.env.VFP_HOSTED_REF = prev;
    }
  });
});

// One small menu, described the same way on both sides.
type Row = Record<string, unknown>;
const page = { url: "https://example-restaurant.test/menu", content_sha256: "a".repeat(64), retrieved_at: "2026-11-20T10:00:00.000000Z", access: "private_pilot" };
const fact = (id: string, kind: string, value: unknown, extra: Row = {}): Row => ({
  id, place: "Test Kitchen", dish: "Lentil Bowl", kind, subject: null, value, status: "submitted", transcribed: false,
  is_unknown: false, unknown_reason: null, checked_on: "2026-11-20", confidence: "high", ...page, ...extra,
});
const db = (ids: string, over: (f: Row[]) => Row[] = (f) => f, placeOver: Row = {}) => {
  const facts = over([fact(`${ids}1`, "menu_item", { name: "Lentil Bowl" }), fact(`${ids}2`, "price", { amount: 14 }), fact(`${ids}3`, "dietary_status", { diet: "vegan" })]);
  return describeDb({
    facts: facts as never,
    places: [{ id: `${ids}p`, label: "Test Kitchen", address: [{ street: "1 Test St", postcode: "02116" }], catalog: [["overture_places", "ov-1"]], ...placeOver }] as never,
    dishes: [{ id: `${ids}d`, place: "Test Kitchen", dish: "Lentil Bowl" }] as never,
  });
};
/** Exports decisions from a source description, as scripts/review-transfer.mjs export does. */
const exported = (src: ReturnType<typeof db>, decisions: { kind: string; key: string; sourceId: string }[]) => ({
  source: { fingerprint: "src-1:postgres" },
  decisions: decisions.map((d) => {
    const f = src.facts.get(d.key)!;
    return {
      kind: d.kind, sourceId: d.sourceId, at: "2026-11-25T22:00:00Z", label: d.key,
      place: { label: "Test Kitchen", identity: src.places.get("Test Kitchen")!.identity },
      dish: { label: "Lentil Bowl", fingerprint: src.dishes.get(JSON.stringify(["Test Kitchen", "Lentil Bowl"]))!.fingerprint },
      fact: d.kind.startsWith("fact_") ? { key: d.key, evidence: f.evidence } : undefined,
    };
  }),
});
const key = (kind: string, value: unknown) => JSON.stringify(["Test Kitchen", "Lentil Bowl", kind, null, value]);
const tgt = (view: ReturnType<typeof db>, transferred: string[] = []) => ({ ...view, transferred: new Set(transferred), candidates: new Map() });

describe("carrying founder decisions by exact match", () => {
  const src = db("s");
  const file = exported(src, [
    { kind: "fact_transcription", key: key("menu_item", { name: "Lentil Bowl" }), sourceId: "1" },
    { kind: "fact_transcription", key: key("price", { amount: 14 }), sourceId: "2" },
    { kind: "tester_decision", key: key("menu_item", { name: "Lentil Bowl" }), sourceId: "3" },
  ]);

  it("replays every decision when restaurant, branch, dish, fact and evidence are identical (ids differ)", () => {
    const plan = planTransfer(file as never, tgt(db("t")) as never);
    expect(plan.map((p: Row) => p.outcome)).toEqual(["replay", "replay", "replay"]);
    expect((plan[0] as Row).targetId).toBe("t1");
    expect((plan[2] as Row).targetId).toBe("td");
    expect(summarise(plan).mayApply).toBe(true);
  });
  it("is idempotent: a decision already in the target's audit log is skipped", () => {
    const plan = planTransfer(file as never, tgt(db("t"), ["src-1:postgres:fact_transcription:1"]) as never);
    expect(plan.map((p: Row) => p.outcome)).toEqual(["done", "replay", "replay"]);
    const all = planTransfer(file as never, tgt(db("t"), ["src-1:postgres:fact_transcription:1", "src-1:postgres:fact_transcription:2", "src-1:postgres:tester_decision:3"]) as never);
    expect(summarise(all)).toMatchObject({ replay: 0, done: 3, mayApply: false });
  });
  it("refuses when the saved page differs (a different evidence version)", () => {
    const t = db("t", (fs) => fs.map((f) => (f.kind === "price" ? { ...f, content_sha256: "b".repeat(64) } : f)));
    const plan = planTransfer(file as never, tgt(t) as never);
    expect(plan.find((p: Row) => p.sourceId === "2")).toMatchObject({ outcome: "conflict" });
    expect(summarise(plan).mayApply).toBe(false);
  });
  it("refuses when the branch differs (address or catalog link)", () => {
    const plan = planTransfer(file as never, tgt(db("t", undefined, { address: [{ street: "9 Other St", postcode: "02116" }] })) as never);
    expect(plan.every((p: Row) => p.outcome === "conflict")).toBe(true);
    const unlinked = planTransfer(file as never, tgt(db("t", undefined, { catalog: [] })) as never);
    expect(unlinked.every((p: Row) => p.outcome === "conflict")).toBe(true);
  });
  it("refuses when the dish's facts differ, even for a fact that itself matches", () => {
    const t = db("t", (fs) => [...fs, fact("t9", "ingredient_list", { items: ["egg"] })]);
    const plan = planTransfer(file as never, tgt(t) as never);
    expect(plan.every((p: Row) => p.outcome === "conflict")).toBe(true);
  });
  it("refuses a fact that was already decided on the target, and never overwrites it", () => {
    const t = db("t", (fs) => fs.map((f) => (f.kind === "menu_item" ? { ...f, transcribed: true } : f)));
    expect(planTransfer(file as never, tgt(t) as never)[0]).toMatchObject({ outcome: "conflict" });
    const r = db("t", (fs) => fs.map((f) => (f.kind === "menu_item" ? { ...f, status: "rejected" } : f)));
    expect(planTransfer(file as never, tgt(r) as never)[0]).toMatchObject({ outcome: "conflict" });
  });
  it("refuses when the restaurant or the fact is missing on the target", () => {
    const t = db("t", (fs) => fs.filter((f) => f.kind !== "price"));
    expect(planTransfer(file as never, tgt(t) as never).find((p: Row) => p.sourceId === "2")).toMatchObject({ outcome: "conflict" });
    const none = describeDb({ facts: [], places: [], dishes: [] });
    expect(planTransfer(file as never, tgt(none) as never).every((p: Row) => p.outcome === "conflict")).toBe(true);
  });
});

// The dangerous cases (owner overnight directive 26 Nov 2026 06:48 UTC, part 5): every one must fail closed.
describe("transfer fails closed on every near miss", () => {
  const src = db("s");
  const one = (kind: string, k: string) => exported(src, [{ kind, key: k, sourceId: "9" }]);
  const itemKey = key("menu_item", { name: "Lentil Bowl" });
  const outcome = (file: unknown, t: ReturnType<typeof db>) => planTransfer(file as never, tgt(t) as never)[0] as Row;

  it("wrong restaurant: the same dish at a different restaurant never matches", () => {
    const t = describeDb({
      facts: [fact("t1", "menu_item", { name: "Lentil Bowl" }, { place: "Test Kitchen Two" })] as never,
      places: [{ id: "tp", label: "Test Kitchen Two", address: [], catalog: [] }] as never,
      dishes: [{ id: "td", place: "Test Kitchen Two", dish: "Lentil Bowl" }] as never,
    });
    expect(outcome(one("fact_transcription", itemKey), t)).toMatchObject({ outcome: "conflict" });
  });
  it("similar dish name: 'Lentil Bowl (Large)' is not 'Lentil Bowl'", () => {
    const t = describeDb({
      facts: [fact("t1", "menu_item", { name: "Lentil Bowl" }, { dish: "Lentil Bowl (Large)" })] as never,
      places: [{ id: "tp", label: "Test Kitchen", address: [{ street: "1 Test St", postcode: "02116" }], catalog: [["overture_places", "ov-1"]] }] as never,
      dishes: [{ id: "td", place: "Test Kitchen", dish: "Lentil Bowl (Large)" }] as never,
    });
    expect(outcome(one("fact_transcription", itemKey), t)).toMatchObject({ outcome: "conflict", reason: expect.stringMatching(/dish/) });
  });
  it("changed price: a decision on $14 never lands on $15", () => {
    const t = db("t", (fs) => fs.map((f) => (f.kind === "price" ? { ...f, value: { amount: 15 } } : f)));
    expect(outcome(one("fact_transcription", key("price", { amount: 14 })), t)).toMatchObject({ outcome: "conflict" });
  });
  it("changed dietary statement: a review of 'vegan' never lands on 'vegetarian'", () => {
    const t = db("t", (fs) => fs.map((f) => (f.kind === "dietary_status" ? { ...f, value: { diet: "vegetarian" } } : f)));
    expect(outcome(one("fact_transcription", key("dietary_status", { diet: "vegan" })), t)).toMatchObject({ outcome: "conflict" });
  });
  it("missing source: a fact on the target with no saved page never matches one that had one", () => {
    const t = db("t", (fs) => fs.map((f) => (f.kind === "menu_item" ? { ...f, url: null, content_sha256: null, retrieved_at: null } : f)));
    expect(outcome(one("fact_transcription", itemKey), t)).toMatchObject({ outcome: "conflict" });
  });
  it("source updated after the review: a newer retrieval of the same page is a different evidence version", () => {
    const t = db("t", (fs) => fs.map((f) => (f.kind === "menu_item" ? { ...f, retrieved_at: "2026-11-27T10:00:00.000000Z" } : f)));
    expect(outcome(one("fact_transcription", itemKey), t)).toMatchObject({ outcome: "conflict" });
  });
  it("access state changed: a source no longer cleared for the private pilot is refused", () => {
    const t = db("t", (fs) => fs.map((f) => ({ ...f, access: "prohibited" })));
    expect(outcome(one("fact_transcription", itemKey), t)).toMatchObject({ outcome: "conflict" });
  });
  it("duplicate import: two identical facts on the target are never guessed between", () => {
    const t = db("t", (fs) => [...fs, { ...fs[0], id: "t1b" }]);
    expect(outcome(one("fact_transcription", itemKey), t)).toMatchObject({ outcome: "conflict" });
  });
  it("two decisions in one file on the same fact: refused, never applied in some order", () => {
    const file = exported(src, [{ kind: "fact_transcription", key: itemKey, sourceId: "1" }, { kind: "fact_review", key: itemKey, sourceId: "2" }]);
    const plan = planTransfer(file as never, tgt(db("t")) as never);
    expect(plan.some((p: Row) => p.outcome === "conflict")).toBe(true);
    expect(summarise(plan).mayApply).toBe(false);
  });
  it("identity decisions match only the exact catalog records and their versions", () => {
    const cand = { key: { name: "Test Kitchen", street: "1 Test St", postcode: "02116", records: [["overture_places", "ov-1"]] }, evidence: { recordHashes: [["overture_places", "ov-1", "h1"]] } };
    const file = { source: { fingerprint: "src-1:postgres" }, decisions: [{ kind: "identity_decision", sourceId: "identity_decisions-1", at: "2026-11-25T22:00:00Z", label: "Test Kitchen", table: "identity_decisions", candidate: cand }] };
    const base = describeDb({ facts: [], places: [], dishes: [] });
    const withCand = (evidence: unknown, reviewItem = false) => ({ ...base, transferred: new Set<string>(), candidates: new Map([[stableKey(cand.key), { id: "c1", evidence, reviewItem }]]) });
    expect((planTransfer(file as never, withCand(cand.evidence) as never)[0] as Row).outcome).toBe("replay");
    expect((planTransfer(file as never, withCand({ recordHashes: [["overture_places", "ov-1", "h2"]] }) as never)[0] as Row).outcome).toBe("conflict");
    expect((planTransfer(file as never, { ...base, transferred: new Set(), candidates: new Map() } as never)[0] as Row).outcome).toBe("conflict");
  });
});
