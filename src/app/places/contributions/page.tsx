import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell, Loading } from "@/components/app-shell";
import { SignInPrompt } from "@/components/social/bits";
import { BRANCH_FIELDS, CONFLICT_WORDS, DIET_CLAIMS, FIELDS, STATUS_WORDS, kindLabel, sourceLabel, type QueueItem } from "@/contracts/community";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { getSuggestionQueue } from "@/server/member/community";
import { reviewSuggestionAction } from "@/app/contribute/actions";

export const metadata = { title: "Suggestions from members (private)", robots: { index: false, follow: false } };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const MESSAGES: Record<string, string> = {
  useful_lead: "Marked as a useful lead. Nothing on any restaurant changed: check it at its source in the usual way.",
  needs_more: "Marked as needing more detail. The member sees that on their page.",
  not_used: "Marked as not used.",
};
const LABEL: Record<string, string> = {
  name: "Restaurant", street: "Street", area: "Area", website: "Website", dish: "Dish", quote: "Their words", ingredients: "Ingredients",
  price: "Price ($)", protein: "Protein (g)", unit: "Per", url: "Link", seenOn: "Seen on", note: "Note", wrong: "We show", right: "Should say",
};
function value(k: string, v: string) {
  if (k === "source") return sourceLabel(v);
  if (k === "diet") return DIET_CLAIMS.find((d) => d.v === v)?.label ?? (v === "not_stated" ? "Not stated by the restaurant" : v);
  if (k === "field") return FIELDS.find((f) => f.v === v)?.label ?? BRANCH_FIELDS.find((f) => f.v === v)?.label ?? v;
  if (k === "unit") return v === "per_100g" ? "100 g" : "serving";
  return v;
}
const ORDER = ["name", "street", "area", "website", "dish", "diet", "quote", "ingredients", "field", "wrong", "right", "price", "protein", "unit", "source", "url", "seenOn", "note"];

/**
 * Leads first that most help coverage: a new restaurant or a missing dish, then what the restaurant says about diet
 * (vegan and egg-free statements are the scarcest evidence), then the rest; places several members point at come
 * before single mentions.
 */
const WEIGHT: Record<string, number> = {
  missing_dish: 0, missing_restaurant: 1, diet_info: 2, ingredients: 3, stale_menu: 4, branch_correction: 5, duplicate_restaurant: 6, nutrition_source: 7, menu_correction: 8, price: 9,
};
const sorted = (q: QueueItem[]) => [...q].sort((a, b) => (WEIGHT[a.kind] ?? 9) - (WEIGHT[b.kind] ?? 9) || b.duplicates - a.duplicates || b.samePlace - a.samePlace || b.createdAt.localeCompare(a.createdAt));

async function Queue({ searchParams }: { searchParams: Promise<RawParams> }) {
  const sp = await searchParams;
  const member = await getCurrentMember();
  if (!member) return <SignInPrompt next="/places/contributions"><p>Sign in to review suggestions.</p></SignInPrompt>;
  const queue = await getSuggestionQueue();
  if (queue === null) notFound();
  const open = sorted(queue.filter((q) => q.status === "submitted" || q.status === "needs_more"));
  const done = queue.filter((q) => q.status === "useful_lead" || q.status === "not_used");
  const msg = MESSAGES[one(sp.m) ?? ""];
  return (
    <>
      <p className="callout calm" data-testid="contrib-status">
        A suggestion is a lead, never a fact. Marking it useful changes nothing on any restaurant; you still check it at its source and confirm
        facts in the usual places.
      </p>
      {msg && <p className="callout ok" role="status" data-testid="contrib-message">{msg}</p>}
      <h2 className="h-sec">To review ({open.length})</h2>
      {open.length === 0 ? (
        <p className="muted" data-testid="contrib-empty">Nothing waiting.</p>
      ) : (
        <ul className="list-plain">
          {open.map((q) => (
            <li key={q.id} className="panel queue-item" data-testid="contrib-item" data-kind={q.kind}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <strong>{kindLabel(q.kind)}</strong>
                <span className="s13 muted">Contributor {q.contributor} · {new Date(q.createdAt).toLocaleDateString("en-US", { timeZone: "America/New_York" })}</span>
              </div>
              {q.listing && (
                <div className="s14">
                  <Link href={`/places/${q.listing.slug}`}>{q.listing.name}</Link>, {q.listing.street}
                  {q.dish ? ` · ${q.dish.label}` : ""}
                  {q.samePlace > 1 && <span className="dchip draft" style={{ marginLeft: 6 }}>{q.samePlace} suggestions for this place</span>}
                </div>
              )}
              {q.duplicates > 0 && (
                <p className="s13" style={{ margin: "4px 0" }} data-testid="contrib-duplicates">
                  <span className="dchip draft">Same suggestion from {q.duplicates} other {q.duplicates === 1 ? "person" : "people"}</span>
                </p>
              )}
              {q.alreadyListed && q.alreadyListed.length > 0 && (
                <p className="s13" style={{ margin: "4px 0" }} data-testid="contrib-already-listed">
                  <strong>Already in the directory?</strong>{" "}
                  {q.alreadyListed.map((x, i) => (
                    <span key={x.slug}>
                      {i > 0 ? "; " : ""}
                      <Link href={`/places/${x.slug}`}>{x.name}</Link>
                      {x.street ? `, ${x.street}` : ""}
                    </span>
                  ))}
                </p>
              )}
              <dl className="evidence">
                {ORDER.filter((k) => q.details[k]).map((k) => (
                  <div key={k}>
                    <dt>{k === "source" ? "Where they saw it" : k === "diet" ? "Diet, as they report it" : k === "field" ? "What's wrong" : LABEL[k]}</dt>
                    <dd>{k === "url" || k === "website" ? <a href={q.details[k]} rel="noopener noreferrer nofollow" target="_blank">{q.details[k]}</a> : value(k, q.details[k])}</dd>
                  </div>
                ))}
              </dl>
              {q.conflicts.length > 0 && (
                <ul className="callout warn s13" data-testid="contrib-conflicts" style={{ margin: "6px 0", paddingLeft: 20 }}>
                  {q.conflicts.map((c) => (
                    <li key={c}>{CONFLICT_WORDS[c] ?? c}</li>
                  ))}
                </ul>
              )}
              {q.current && (
                <p className="s13 muted" data-testid="contrib-current" style={{ margin: "4px 0" }}>
                  Our draft now:{" "}
                  {Object.entries(q.current.diet).map(([k, v]) => `${k} ${v === "yes" ? "yes" : "no"}`).join(", ") || "no diet claim"}
                  {q.current.price ? ` · $${q.current.price}` : ""}
                  {q.current.ingredientsListed ? " · ingredients listed" : " · no ingredients listed"}
                </p>
              )}
              {q.kind === "diet_info" && q.dish && q.details.source === "asked_staff" && (
                <p className="s13" style={{ margin: "4px 0" }}>
                  <Link href={`/places/menus/confirm/${q.dish.id}`} data-testid="contrib-record-link">
                    Record your own answer for this dish
                  </Link>{" "}
                  (only an answer you obtain yourself counts as staff-confirmed; a member&rsquo;s report stays a lead).
                </p>
              )}
              <p className="s13 muted" style={{ margin: "4px 0" }}>Never published: a suggestion is not eligible to appear anywhere by itself.</p>
              {q.history.length > 1 && (
                <details className="s13">
                  <summary>History ({q.history.length})</summary>
                  <ol data-testid="contrib-history">
                    {q.history.map((h, i) => (
                      <li key={i}>
                        {new Date(h.at).toLocaleString("en-US", { timeZone: "America/New_York" })}: {h.by === "founder" ? "You" : "The member"}: {STATUS_WORDS[h.to] ?? h.to}
                        {h.note ? ` (${h.note})` : ""}
                      </li>
                    ))}
                  </ol>
                </details>
              )}
              {q.status === "needs_more" && <p className="s13 muted">You asked for more: {q.reviewNote}</p>}
              <form action={reviewSuggestionAction} className="stack">
                <input type="hidden" name="id" value={q.id} />
                <label htmlFor={`note-${q.id}`} className="s14">Note (the member sees it)</label>
                <input id={`note-${q.id}`} name="note" type="text" maxLength={500} />
                <div className="row">
                  <button className="btn primary" name="status" value="useful_lead" data-testid="contrib-useful">Useful lead</button>
                  <button className="btn" name="status" value="needs_more" data-testid="contrib-more">Needs more</button>
                  <button className="btn" name="status" value="not_used" data-testid="contrib-not-used">Not used</button>
                </div>
              </form>
            </li>
          ))}
        </ul>
      )}
      <h2 className="h-sec">Reviewed ({done.length})</h2>
      <ul className="list-plain">
        {done.slice(0, 50).map((q) => (
          <li key={q.id} className="panel" data-testid="contrib-done">
            {kindLabel(q.kind)}{q.listing ? ` · ${q.listing.name}` : q.details.name ? ` · ${q.details.name}` : ""} — {STATUS_WORDS[q.status]}
          </li>
        ))}
      </ul>
    </>
  );
}

export default function ContributionsPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  return (
    <AppShell active="discover">
      <p className="eyebrow">Private</p>
      <h1 className="title">Suggestions from members</h1>
      <Suspense fallback={<Loading label="Loading suggestions…" />}>
        <Queue searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}
