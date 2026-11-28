import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell, Loading } from "@/components/app-shell";
import { reviewChangeAction, saveChangeAction } from "@/app/editor/actions";
import { PracticeNote, StaffDenied, StaffNav, StateBadge } from "@/components/editor/bits";
import { Flash, SignInPrompt } from "@/components/social/bits";
import { idSchema } from "@/contracts/catalog";
import {
  FAMILIES,
  FAMILY_LABELS,
  GATE_LABELS,
  NUTRIENTS,
  NUTRIENT_LABELS,
  OUTCOME_LABELS,
  PRESENCE_LABELS,
  SOURCE_TYPES,
  SOURCE_TYPE_LABELS,
  type Change,
  type Evidence,
  type PlaceValues,
  type VenueHistory,
} from "@/contracts/editor";
import { formatDate, titleCase } from "@/lib/format";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { getChange, getItems, getStaffAlerts, getVenueHistory } from "@/server/editor";
import { SocialError } from "@/server/social";
import { HoursFields } from "@/components/editor/hours-fields";
import { getVenueHours } from "@/server/catalog/hours";
import { weeklyHoursSchema, type WeeklyHours } from "@/contracts/hours";
import { weeklyLines } from "@/lib/hours-words";

/** MAP-2: checked hours already saved on this draft, if any. */
function draftHours(p: Record<string, unknown>): WeeklyHours | null {
  const parsed = weeklyHoursSchema.safeParse(p.structuredHours);
  return parsed.success ? parsed.data : null;
}

export const metadata = { title: "Catalog change", robots: { index: false, follow: false } };

const HISTORY_WORDS: Record<string, string> = {
  "catalog_change.started": "Draft started",
  "catalog_change.submitted": "Sent for checking",
  "catalog_change.published": "Checked and published",
  "catalog_change.rejected": "Sent back",
  "catalog_change.withdrawn": "Withdrawn",
};
const VENUE_TYPES = ["restaurant", "cafe", "bakery", "food_truck", "market_stall", "other"];
const VENUE_FIELDS: [string, string][] = [
  ["name", "Name"], ["neighborhood", "Neighbourhood"], ["street", "Street"], ["locality", "Town or city"], ["region", "State"], ["postalCode", "Postal code"],
  ["venueType", "Kind of place"], ["status", "Status"], ["lat", "Latitude"], ["lon", "Longitude"], ["hours", "Hours"], ["statusNote", "Note"],
];
/** One row per place fact that has a value. */
const placeRows = (v: Record<string, unknown> | null | undefined) => {
  const rows = new Map(VENUE_FIELDS.filter(([k]) => v?.[k] != null && v?.[k] !== "").map(([k, label]) => [label, String(v![k]).replace("_", " ")]));
  // MAP-2: checked hours, one line, so the second person sees exactly what will be published.
  const h = weeklyHoursSchema.safeParse(v?.structuredHours);
  if (h.success) {
    rows.set("Checked hours", weeklyLines(h.data).map((l) => `${l.day.slice(0, 3)} ${l.text}`).join("; "));
    if (h.data.exceptions.length)
      rows.set("Dated changes", h.data.exceptions.map((e) => `${e.startsOn}${e.endsOn !== e.startsOn ? ` to ${e.endsOn}` : ""} ${e.kind.replace("_", " ")}${e.opens ? ` ${e.opens}-${e.closes}` : ""}${e.reason ? ` (${e.reason})` : ""}`).join("; "));
  }
  return rows;
};

/** Every published change to this place, newest first, with what it was before and after. Kept for good. */
function PlaceHistory({ history }: { history: VenueHistory }) {
  if (history.revisions.length === 0) return <p className="muted s14">No checked change has been published for this place yet.</p>;
  return (
    <ol className="feed" data-testid="place-history" style={{ listStyle: "none", padding: 0 }}>
      {history.revisions.map((r) => {
        const before = placeRows(r.before);
        const after = placeRows(r.after);
        const changed = [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k));
        return (
          <li className="post" key={r.revisionId} data-revision={r.revisionNo}>
            <p className="kind" style={{ margin: 0 }}>
              Version {r.revisionNo} · published {formatDate(r.publishedAt)}
            </p>
            <p className="s14" style={{ margin: "4px 0 0" }}>
              Entered by {r.author ?? "someone who has left"} · checked by {r.reviewer ?? "someone who has left"}
            </p>
            <p className="s14 muted" style={{ margin: "4px 0 0" }}>
              Source: {r.source.publisher ?? "not recorded"}
              {r.source.observedAt ? `, seen ${formatDate(r.source.observedAt)}` : ""}
              {r.source.summary ? `. ${r.source.summary}` : ""}
            </p>
            {r.before === null ? (
              <p className="s14" style={{ margin: "6px 0 0" }}>First published version of this place.</p>
            ) : changed.length === 0 ? (
              <p className="s14" style={{ margin: "6px 0 0" }}>Checked again; nothing changed.</p>
            ) : (
              <ul className="s14" style={{ margin: "6px 0 0", paddingLeft: 20 }}>
                {changed.map((k) => (
                  <li key={k}>
                    <strong>{k}:</strong> {before.get(k) ?? "not stated"} → {after.get(k) ?? "removed"}
                  </li>
                ))}
              </ul>
            )}
            <p className="s13" style={{ margin: "6px 0 0" }}>
              <Link className="link" href={`/editor/changes/${r.changeId}`}>
                The change record
              </Link>
            </p>
          </li>
        );
      })}
    </ol>
  );
}

/** One row per fact, with what is published now beside what is proposed. Changed rows say so in words. */
const ALLERGEN_WORDS: Record<string, string> = { milk: "milk", egg: "egg", peanut: "peanuts", tree_nut: "tree nuts", soy: "soy", wheat: "wheat", sesame: "sesame", fish: "fish", shellfish: "shellfish", mustard: "mustard", celery: "celery", lupin: "lupin", sulfite: "sulfites", gluten: "gluten" };

function rowsFor(e: Evidence | null): Map<string, string> {
  const m = new Map<string, string>();
  if (!e) return m;
  m.set("Name", e.name);
  m.set("Description", e.description ?? "None");
  for (const d of e.dietary) {
    m.set(
      `${titleCase(d.diet)}`,
      `${OUTCOME_LABELS[d.outcome] ?? d.outcome}${d.modifications ? ` (${d.modifications})` : ""}${d.conflictState === "disputed" ? " · disputed" : ""}`,
    );
  }
  for (const f of e.families) m.set(FAMILY_LABELS[f.family] ?? f.family, `${PRESENCE_LABELS[f.presence] ?? f.presence}${f.detail ? ` (${f.detail})` : ""}`);
  // Allergens, in words: what is stated as present, stated as absent, and what the restaurant says may be cross-contact.
  const words = (codes: string[]) => codes.map((a) => ALLERGEN_WORDS[a] ?? a.replace(/_/g, " ")).join(", ");
  const contains = e.allergens.filter((a) => a.presence === "present").map((a) => a.allergen);
  const free = e.allergens.filter((a) => a.presence === "absent_by_statement").map((a) => a.allergen);
  const may = e.allergens.filter((a) => a.presence !== "present" && a.crossContact === "reported").map((a) => a.allergen);
  if (contains.length) m.set("Allergens: contains", words(contains));
  if (free.length) m.set("Allergens: stated free from", words(free));
  if (may.length) m.set("Allergens: may contain (cross-contact)", words(may));
  for (const n of e.nutrients) m.set(NUTRIENT_LABELS[n.code] ?? n.code, n.value === null ? "Not known" : `${n.value} (${n.method})`);
  if (e.recipe) {
    m.set("Makes", `${e.recipe.yieldServings} servings`);
    m.set("Time", `${e.recipe.prepMinutes ?? "?"} min to prepare, ${e.recipe.cookMinutes ?? "?"} min to cook`);
    const trial = e.recipe.trialCookedAt;
    m.set("Trial cook", (trial && formatDate(trial)) || "Not recorded");
    m.set("Ingredients", e.recipe.ingredients.map((i) => `${i.name} ${i.grams ?? i.quantity} g`).join("; ") || "None");
    m.set("Steps", e.recipe.steps.map((s, i) => `${i + 1}. ${s.instruction}`).join(" ") || "None");
  }
  return m;
}

function Compare({ change, history }: { change: Change; history: VenueHistory | null }) {
  let before: Map<string, string>;
  let after: Map<string, string>;
  if (change.kind === "venue") {
    // A published change shows the values kept in the place's history, never today's values.
    const kept = history?.revisions.find((r) => r.changeId === change.changeId);
    const cur: PlaceValues | null = kept ? kept.before : change.state === "published" ? null : (history?.current ?? null);
    before = placeRows(cur);
    after = placeRows(kept ? kept.after : (change.payload as Record<string, unknown>));
  } else {
    before = rowsFor(change.base);
    after = rowsFor(change.draft);
    const dish = change.payload.dish;
    if (dish?.priceCents) after.set("Price", `$${(dish.priceCents / 100).toFixed(2)}${dish.servingDescription ? ` (${dish.servingDescription})` : ""}`);
    if (dish?.menuSection) after.set("Menu section", dish.menuSection);
  }
  const keys = [...new Set([...before.keys(), ...after.keys()])];
  const isNew = before.size === 0;
  return (
    <div className="table-wrap">
      <table className="s14" data-testid="change-compare" style={{ width: "100%", borderCollapse: "collapse" }}>
        <caption className="sr-only">What is published now beside what is proposed</caption>
        <thead>
          <tr>
            <th scope="col" style={{ textAlign: "left", padding: "6px 8px 6px 0" }}>Fact</th>
            {!isNew && <th scope="col" style={{ textAlign: "left", padding: "6px 8px" }}>Published now</th>}
            <th scope="col" style={{ textAlign: "left", padding: "6px 8px" }}>Proposed</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => {
            const changed = !isNew && before.get(k) !== after.get(k);
            return (
              <tr key={k} data-changed={changed ? "yes" : "no"} style={{ borderTop: "1px solid var(--border)", verticalAlign: "top" }}>
                <th scope="row" style={{ textAlign: "left", padding: "6px 8px 6px 0", fontWeight: 700 }}>{k}</th>
                {!isNew && <td style={{ padding: "6px 8px", overflowWrap: "anywhere" }}>{before.get(k) ?? "Not stated"}</td>}
                <td style={{ padding: "6px 8px", overflowWrap: "anywhere" }}>
                  {after.get(k) ?? "Removed"}
                  {changed && (
                    <>
                      {" "}
                      <span className="badge wait">Changed</span>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

async function EditForm({ change }: { change: Change }) {
  const d = change.draft;
  const p = change.payload;
  const s = change.source;
  const ingredients = d?.recipe ? (await getItems()).ingredients : [];
  const currentHours = change.kind === "venue" && change.target.venueId ? await getVenueHours(change.target.venueId) : null;
  const id = change.changeId;
  return (
    <form action={saveChangeAction} className="stack" data-testid="change-form">
      <input type="hidden" name="return" value={`/editor/changes/${id}`} />
      <input type="hidden" name="changeId" value={id} />

      <fieldset className="panel">
        <legend className="h-sec" style={{ marginTop: 0 }}>1. The source</legend>
        <p className="s14 muted">Who says so, where you saw it and when. Every dietary, ingredient and nutrition statement you change is tied to this.</p>
        <div className="field-grid">
          <div>
            <label htmlFor="sourcePublisher">Who says so</label>
            <input id="sourcePublisher" name="sourcePublisher" type="text" maxLength={200} defaultValue={s?.publisher ?? ""} autoComplete="off" />
          </div>
          <div>
            <label htmlFor="sourceType">Kind of source</label>
            <select id="sourceType" name="sourceType" defaultValue={s?.sourceType ?? "operator_statement"}>
              {SOURCE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {SOURCE_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="sourceObservedOn">Date you saw or heard it</label>
            <input id="sourceObservedOn" name="sourceObservedOn" type="date" defaultValue={s?.observedAt ? s.observedAt.slice(0, 10) : ""} />
          </div>
          <div>
            <label htmlFor="sourceUrl">Web address, if there is one (optional)</label>
            <input id="sourceUrl" name="sourceUrl" type="url" placeholder="https://" defaultValue={s?.url ?? ""} autoComplete="off" />
          </div>
        </div>
        <div>
          <label htmlFor="sourceSummary">What the source says, in your own words</label>
          <textarea id="sourceSummary" name="sourceSummary" rows={2} maxLength={1000} defaultValue={s?.summary ?? ""} />
        </div>
      </fieldset>

      <fieldset className="panel">
        <legend className="h-sec" style={{ marginTop: 0 }}>2. What changed and why</legend>
        <div>
          <label htmlFor="summary">One line for the person who will check this</label>
          <input id="summary" name="summary" type="text" maxLength={300} defaultValue={change.summary ?? ""} autoComplete="off" />
        </div>
      </fieldset>

      {change.kind === "venue" ? (
        <fieldset className="panel">
          <legend className="h-sec" style={{ marginTop: 0 }}>3. The place</legend>
          <div className="field-grid">
            <div>
              <label htmlFor="name">Name</label>
              <input id="name" name="name" type="text" maxLength={200} defaultValue={p.name ?? ""} autoComplete="off" />
            </div>
            <div>
              <label htmlFor="venueType">Kind of place</label>
              <select id="venueType" name="venueType" defaultValue={p.venueType ?? "restaurant"}>
                {VENUE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {titleCase(t.replace("_", " "))}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="neighborhood">Neighbourhood</label>
              <input id="neighborhood" name="neighborhood" type="text" maxLength={120} defaultValue={p.neighborhood ?? ""} autoComplete="off" />
            </div>
            <div>
              <label htmlFor="street">Street</label>
              <input id="street" name="street" type="text" maxLength={200} defaultValue={p.street ?? ""} autoComplete="off" />
            </div>
            <div>
              <label htmlFor="locality">Town or city</label>
              <input id="locality" name="locality" type="text" maxLength={120} defaultValue={p.locality ?? ""} autoComplete="off" />
            </div>
            <div>
              <label htmlFor="region">State</label>
              <input id="region" name="region" type="text" maxLength={60} defaultValue={p.region ?? ""} autoComplete="off" />
            </div>
            <div>
              <label htmlFor="postalCode">Postal code</label>
              <input id="postalCode" name="postalCode" type="text" maxLength={20} defaultValue={p.postalCode ?? ""} autoComplete="off" />
            </div>
            <div>
              <label htmlFor="status">Status</label>
              <select id="status" name="status" defaultValue={p.status ?? "published"}>
                <option value="published">Open</option>
                <option value="temporarily_closed">Temporarily closed</option>
                <option value="closed">Closed for good</option>
              </select>
            </div>
            <div>
              <label htmlFor="lat">Latitude (optional)</label>
              <input id="lat" name="lat" type="text" inputMode="decimal" defaultValue={p.lat ?? ""} autoComplete="off" />
            </div>
            <div>
              <label htmlFor="lon">Longitude (optional)</label>
              <input id="lon" name="lon" type="text" inputMode="decimal" defaultValue={p.lon ?? ""} autoComplete="off" />
            </div>
          </div>
          <div>
            <label htmlFor="hours">Hours, as the source gives them (optional)</label>
            <input id="hours" name="hours" type="text" maxLength={500} defaultValue={p.hours ?? ""} autoComplete="off" />
          </div>
          <div>
            <label htmlFor="statusNote">Note for visitors (optional)</label>
            <input id="statusNote" name="statusNote" type="text" maxLength={300} defaultValue={p.statusNote ?? ""} autoComplete="off" />
          </div>
        </fieldset>
      ) : null}
      {change.kind === "venue" ? (
        <HoursFields draft={draftHours(p)} current={currentHours?.hours ?? null} />
      ) : (
        d && (
          <>
            <fieldset className="panel">
              <legend className="h-sec" style={{ marginTop: 0 }}>3. Name and description</legend>
              <div>
                <label htmlFor="name">Name</label>
                <input id="name" name="name" type="text" maxLength={200} defaultValue={d.name} autoComplete="off" />
              </div>
              <div>
                <label htmlFor="description">Description, in our own words</label>
                <textarea id="description" name="description" rows={3} maxLength={2000} defaultValue={d.description ?? ""} />
              </div>
              {change.target.kind === "dish" && (
                <div className="field-grid">
                  <div>
                    <label htmlFor="menuSection">Menu section (optional)</label>
                    <input id="menuSection" name="menuSection" type="text" maxLength={120} defaultValue={p.dish?.menuSection ?? ""} autoComplete="off" />
                  </div>
                  <div>
                    <label htmlFor="priceDollars">Price in dollars (optional)</label>
                    <input id="priceDollars" name="priceDollars" type="text" inputMode="decimal" defaultValue={p.dish?.priceCents ? (p.dish.priceCents / 100).toFixed(2) : ""} autoComplete="off" />
                  </div>
                  <div>
                    <label htmlFor="servingDescription">What the price buys (optional)</label>
                    <input id="servingDescription" name="servingDescription" type="text" maxLength={200} defaultValue={p.dish?.servingDescription ?? ""} autoComplete="off" />
                  </div>
                </div>
              )}
            </fieldset>

            <fieldset className="panel">
              <legend className="h-sec" style={{ marginTop: 0 }}>4. Dietary statements</legend>
              <p className="s14 muted">Choose &ldquo;Not known&rdquo; when the source does not say. Never guess from the name of a dish or the kind of place.</p>
              {(["vegan", "vegetarian"] as const).map((diet) => {
                const now = d.dietary.find((x) => x.diet === diet);
                return (
                  <div className="field-grid" key={diet}>
                    <div>
                      <label htmlFor={`diet_${diet}`}>{titleCase(diet)}</label>
                      <select id={`diet_${diet}`} name={`diet_${diet}`} defaultValue={now?.outcome ?? "keep"}>
                        {!now && <option value="keep">No statement</option>}
                        <option value="compatible">Suitable</option>
                        <option value="incompatible">Not suitable</option>
                        <option value="conditional">Only with a change</option>
                        <option value="unknown">Not known</option>
                        {now && <option value="remove">Remove the statement</option>}
                      </select>
                      {now?.conflictState === "disputed" && <p className="s13">This statement is disputed. Saving restates it from your source.</p>}
                    </div>
                    <div>
                      <label htmlFor={`dietmod_${diet}`}>The change needed, if any</label>
                      <input id={`dietmod_${diet}`} name={`dietmod_${diet}`} type="text" maxLength={300} defaultValue={now?.modifications ?? ""} autoComplete="off" />
                    </div>
                  </div>
                );
              })}
              <h3 className="s14" style={{ margin: "12px 0 4px" }}>Ingredients people avoid</h3>
              {FAMILIES.map((family) => {
                const now = d.families.find((x) => x.family === family);
                return (
                  <div className="field-grid" key={family}>
                    <div>
                      <label htmlFor={`fam_${family}`}>{FAMILY_LABELS[family]}</label>
                      <select id={`fam_${family}`} name={`fam_${family}`} defaultValue={now?.presence ?? "keep"}>
                        {!now && <option value="keep">No statement</option>}
                        <option value="present">Contains</option>
                        <option value="absent_by_statement">Stated absent</option>
                        <option value="unknown">Not known</option>
                      </select>
                    </div>
                    <div>
                      <label htmlFor={`famdetail_${family}`}>Detail (optional)</label>
                      <input id={`famdetail_${family}`} name={`famdetail_${family}`} type="text" maxLength={200} defaultValue={now?.detail ?? ""} autoComplete="off" />
                    </div>
                  </div>
                );
              })}
              <p style={{ marginTop: 12 }}>
                <label>
                  <input type="checkbox" name="reconfirm" /> I checked every statement above again against this source, including the ones I did not change
                </label>
              </p>
            </fieldset>

            {!d.recipe && (
              <fieldset className="panel">
                <legend className="h-sec" style={{ marginTop: 0 }}>5. Nutrition per serving</legend>
                <p className="s14 muted">Leave a box empty when the source gives no number. Empty means &ldquo;not known&rdquo;, never zero.</p>
                {NUTRIENTS.map((code) => {
                  const now = d.nutrients.find((x) => x.code === code);
                  return (
                    <div className="field-grid" key={code}>
                      <div>
                        <label htmlFor={`nut_${code}`}>{NUTRIENT_LABELS[code]}</label>
                        <input id={`nut_${code}`} name={`nut_${code}`} type="text" inputMode="decimal" defaultValue={now?.value ?? ""} autoComplete="off" />
                      </div>
                      <div>
                        <label htmlFor={`nutmethod_${code}`}>How the number was obtained</label>
                        <select id={`nutmethod_${code}`} name={`nutmethod_${code}`} defaultValue={now && now.method !== "unknown" ? now.method : "published"}>
                          <option value="published">Published by the source</option>
                          <option value="calculated">Calculated from ingredients</option>
                          <option value="estimated">Estimated (shown as an estimate)</option>
                        </select>
                      </div>
                    </div>
                  );
                })}
              </fieldset>
            )}

            {d.recipe && (
              <fieldset className="panel">
                <legend className="h-sec" style={{ marginTop: 0 }}>5. The recipe</legend>
                <p className="s14 muted">Nutrition is calculated from the ingredients, so there are no nutrition boxes for a recipe.</p>
                <div className="field-grid">
                  <div>
                    <label htmlFor="yieldServings">Servings it makes</label>
                    <input id="yieldServings" name="yieldServings" type="text" inputMode="decimal" defaultValue={d.recipe.yieldServings} autoComplete="off" />
                  </div>
                  <div>
                    <label htmlFor="trialCookedOn">Date it was last trial cooked</label>
                    <input id="trialCookedOn" name="trialCookedOn" type="date" defaultValue={d.recipe.trialCookedAt ? d.recipe.trialCookedAt.slice(0, 10) : ""} />
                  </div>
                  <div>
                    <label htmlFor="prepMinutes">Minutes to prepare</label>
                    <input id="prepMinutes" name="prepMinutes" type="text" inputMode="numeric" defaultValue={d.recipe.prepMinutes ?? ""} autoComplete="off" />
                  </div>
                  <div>
                    <label htmlFor="cookMinutes">Minutes to cook</label>
                    <input id="cookMinutes" name="cookMinutes" type="text" inputMode="numeric" defaultValue={d.recipe.cookMinutes ?? ""} autoComplete="off" />
                  </div>
                </div>
                <h3 className="s14" style={{ margin: "12px 0 4px" }}>Ingredients (grams)</h3>
                {Array.from({ length: Math.max(8, d.recipe.ingredients.length + 2) }).slice(0, 16).map((_, i) => {
                  const row = d.recipe?.ingredients[i];
                  return (
                    <div className="field-grid" key={i}>
                      <div>
                        <label htmlFor={`ing_${i}`} className="sr-only">
                          Ingredient {i + 1}
                        </label>
                        <select id={`ing_${i}`} name={`ing_${i}`} defaultValue={row?.foodItemId ?? ""}>
                          <option value="">(none)</option>
                          {ingredients.map((ing) => (
                            <option key={ing.foodItemId} value={ing.foodItemId}>
                              {ing.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label htmlFor={`inggrams_${i}`} className="sr-only">
                          Grams of ingredient {i + 1}
                        </label>
                        <input id={`inggrams_${i}`} name={`inggrams_${i}`} type="text" inputMode="decimal" placeholder="grams" defaultValue={row ? (row.grams ?? row.quantity) : ""} autoComplete="off" />
                      </div>
                    </div>
                  );
                })}
                <div>
                  <label htmlFor="steps">Steps, one per line, in our own words</label>
                  <textarea id="steps" name="steps" rows={6} defaultValue={d.recipe.steps.map((x) => x.instruction).join("\n")} />
                </div>
              </fieldset>
            )}
          </>
        )
      )}

      <div className="row">
        <button className="btn" type="submit" name="intent" value="save">
          Save draft
        </button>
        <button className="btn primary" type="submit" name="intent" value="submit">
          Save and send for checking
        </button>
        <button className="btn danger" type="submit" name="intent" value="withdraw" formNoValidate>
          Withdraw this draft
        </button>
      </div>
    </form>
  );
}

async function ChangeView({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<RawParams> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const member = await getCurrentMember();
  if (!member) {
    return (
      <SignInPrompt next={`/editor/changes/${id}`}>
        <p>Sign in to continue.</p>
      </SignInPrompt>
    );
  }
  const alerts = await getStaffAlerts();
  if (!alerts?.isEditor) return <StaffDenied what="catalog editors" />;
  if (!idSchema.safeParse(id).success) notFound();
  let change: Change;
  try {
    change = await getChange(id);
  } catch (e) {
    if (e instanceof SocialError && e.status === 404) notFound();
    throw e;
  }
  const s = change.source;
  const placeId = change.kind === "venue" ? change.target.venueId : null;
  const history = placeId ? await getVenueHistory(placeId).catch(() => null) : null;
  return (
    <>
      <StaffNav alerts={alerts} here="" />
      <Flash sp={sp} />
      {change.isDemo !== false && <PracticeNote />}
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 className="h-sec" style={{ margin: 0 }} data-testid="change-title">
          {change.isNew ? "New: " : ""}
          {change.target.name ?? "Unnamed"}
        </h2>
        <StateBadge state={change.state} />
      </div>
      <p className="s14 muted">
        {change.target.kind === "venue" ? "Place" : titleCase(change.target.kind ?? "record")}
        {change.target.venueName ? ` at ${change.target.venueName}` : ""} · entered by {change.authorIsMe ? "you" : (change.author ?? "someone who has left")}
        {change.reviewer ? ` · checked by ${change.reviewer}` : ""}
      </p>
      {change.state === "published" && change.target.foodItemId && (
        <p className="s14">
          <Link className="link" href={change.target.kind === "recipe" ? `/cook/${change.target.foodItemId}` : `/foods/${change.target.foodItemId}`}>
            See the public page
          </Link>
        </p>
      )}
      {change.state === "published" && change.target.venueId && (
        <p className="s14">
          <Link className="link" href={`/venues/${change.target.venueId}`}>
            See the public page
          </Link>
        </p>
      )}

      {change.correction && (
        <div className="panel" data-testid="change-correction">
          <p className="kind" style={{ margin: 0 }}>A member&rsquo;s correction · {titleCase(change.correction.field)}</p>
          <p className="text" style={{ margin: "4px 0 0" }}>{change.correction.proposedValue}</p>
          {change.correction.evidenceNote && <p className="s14 muted" style={{ margin: "6px 0 0" }}>Their evidence: {change.correction.evidenceNote}</p>}
          <p className="s13 muted" style={{ margin: "6px 0 0" }}>A member&rsquo;s report is a lead, not a source. Check it with the place or the label, and record that as the source.</p>
        </div>
      )}

      {change.gate.length > 0 && (
        <div className="callout stop" role="status" data-testid="change-gate">
          <p style={{ margin: 0, fontWeight: 700 }}>This cannot be published as it stands:</p>
          <ul style={{ margin: "6px 0 0", paddingLeft: 20 }}>
            {change.gate.map((g) => (
              <li key={g}>{GATE_LABELS[g] ?? g}</li>
            ))}
          </ul>
        </div>
      )}

      {change.canEdit ? (
        <EditForm change={change} />
      ) : (
        <>
          <h2 className="h-sec">The source</h2>
          {s ? (
            <div className="panel" data-testid="change-source">
              <p style={{ margin: 0, fontWeight: 700 }}>{s.publisher}</p>
              <p className="s14 muted" style={{ margin: "2px 0 0" }}>
                {SOURCE_TYPE_LABELS[s.sourceType] ?? s.sourceType} · seen {formatDate(s.observedAt)}
                {s.rightsStatus === "cleared" ? " · checked for display" : " · not yet checked for display"}
              </p>
              {s.summary && <p className="text" style={{ margin: "6px 0 0" }}>{s.summary}</p>}
              {s.url && <p className="s14" style={{ margin: "6px 0 0", overflowWrap: "anywhere" }}>{s.url}</p>}
            </div>
          ) : (
            <p className="muted">No source recorded.</p>
          )}
          {change.summary && (
            <>
              <h2 className="h-sec">What changed and why</h2>
              <p>{change.summary}</p>
            </>
          )}
          {change.touchesEvidence && (
            <p className="callout" data-testid="change-touches">
              This changes dietary, ingredient or nutrition information that visitors rely on.
            </p>
          )}
          <h2 className="h-sec">{change.isNew ? "What is proposed" : "Published now and proposed"}</h2>
          <Compare change={change} history={history} />
        </>
      )}

      {change.state === "submitted" && change.authorIsMe && (
        <form action={saveChangeAction} style={{ marginTop: 16 }}>
          <input type="hidden" name="return" value={`/editor/changes/${change.changeId}`} />
          <input type="hidden" name="changeId" value={change.changeId} />
          <p className="s14 muted">You entered this, so a different person has to check it.</p>
          <button className="btn danger" type="submit" name="intent" value="withdraw">
            Withdraw this change
          </button>
        </form>
      )}

      {change.state === "submitted" && !change.authorIsMe && !change.canReview && (
        <p className="callout calm" data-testid="change-needs-publisher">
          This is waiting for someone with the publisher role.
        </p>
      )}

      {change.canReview && (
        <form action={reviewChangeAction} className="stack panel" data-testid="review-form" style={{ marginTop: 16 }}>
          <input type="hidden" name="return" value={`/editor/changes/${change.changeId}`} />
          <input type="hidden" name="changeId" value={change.changeId} />
          <h2 className="h-sec" style={{ marginTop: 0 }}>Your check</h2>
          <p>
            <label>
              <input type="checkbox" name="sourceChecked" /> I looked at the source myself and it says what is entered here
            </label>
          </p>
          <p>
            <label>
              <input type="checkbox" name="rightsOk" /> Nothing here is copied text or a photo that we have no right to show
            </label>
          </p>
          <div>
            <label htmlFor="note">Note (needed when sending back)</label>
            <input id="note" name="note" type="text" maxLength={300} autoComplete="off" />
          </div>
          <div className="row">
            <button className="btn primary" type="submit" name="decision" value="approve">
              Approve and publish
            </button>
            <button className="btn" type="submit" name="decision" value="reject">
              Send back
            </button>
          </div>
        </form>
      )}

      {history && (
        <>
          <h2 className="h-sec">History of this place</h2>
          <PlaceHistory history={history} />
        </>
      )}

      <h2 className="h-sec">Record of this change</h2>
      <ol className="s14" data-testid="change-history" style={{ paddingLeft: 20 }}>
        {change.history.map((hEntry, i) => (
          <li key={i}>
            {HISTORY_WORDS[hEntry.action] ?? hEntry.action} · {hEntry.by ?? "someone who has left"} · {formatDate(hEntry.at)}
            {hEntry.note ? ` · ${hEntry.note}` : ""}
          </li>
        ))}
      </ol>
      {change.reviewNote && change.state === "rejected" && (
        <p className="callout" data-testid="change-review-note">
          Sent back: {change.reviewNote}
        </p>
      )}
    </>
  );
}

export default function ChangePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<RawParams> }) {
  return (
    <AppShell active="none" narrow>
      <h1 className="title">Catalog change</h1>
      <Suspense fallback={<Loading />}>
        <ChangeView params={params} searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}
