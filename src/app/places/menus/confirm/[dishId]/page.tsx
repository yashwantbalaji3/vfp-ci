import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { MealListSkeleton, UnverifiedBanner } from "@/components/menu-preview";
import { SignInPrompt } from "@/components/social/bits";
import { FLAGS } from "@/config/flags";
import {
  ANSWER_WORDS,
  ANSWERS,
  CATEGORY_WORDS,
  CLAIMS,
  evidenceCategories,
  METHOD_WORDS,
  METHODS,
  STATE_WORDS,
  TOPIC_WORDS,
  TOPICS,
  type DietConfirmation,
} from "@/contracts/diet-confirmation";
import { evidenceWords } from "@/contracts/meal-eligibility";
import { confirmationRow } from "@/contracts/needs-confirmation";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { getDietConfirmations } from "@/server/catalog/diet-confirmations";
import { getPreviewAudience, getPreviewMeal } from "@/server/catalog/menu-preview";
import { recordDietConfirmationAction, withdrawDietConfirmationAction } from "../actions";

export const metadata = { title: "Record a dietary confirmation (private)", robots: { index: false, follow: false } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const MESSAGES: Record<string, string> = {
  recorded: "Recorded. It is kept as its own kind of evidence; no menu fact changed, and nothing was published.",
  withdrawn: "Withdrawn. The record is kept, marked withdrawn with your reason, and no longer counts.",
};
const ERRORS: Record<string, string> = {
  INVALID_REQUEST: "Some fields were missing or too long. Nothing was recorded. Every field except the name and the method note is required.",
  OBTAINED_IN_FUTURE: "The date the answer was obtained cannot be in the future. Nothing was recorded.",
  OBTAINED_TOO_LONG_AGO: "That answer is more than 120 days old, so it would already have lapsed. Nothing was recorded.",
  ALREADY_WITHDRAWN: "That record was already withdrawn.",
  FOUNDER_ONLY: "Only the founder can record or withdraw dietary confirmations.",
};

/**
 * One meal's independent dietary confirmation records (owner decision 24 Nov 2026 21:20 UTC, decision 2). Founder
 * only. Shows the four kinds of evidence apart, every record with its method, date, source, scope and limits, and a
 * form to record a new documented answer. A record never changes a menu fact and is never shown to members.
 */
async function Record({ params, searchParams }: { params: Promise<{ dishId: string }>; searchParams: Promise<RawParams> }) {
  const { dishId } = await params;
  if (!UUID.test(dishId)) notFound();
  const sp = await searchParams;
  const member = await getCurrentMember();
  if (!member) {
    return (
      <SignInPrompt next={`/places/menus/confirm/${dishId}`}>
        <p>This private page is for the founder. Sign in to continue.</p>
      </SignInPrompt>
    );
  }
  if ((await getPreviewAudience()) !== "founder") notFound();
  const found = await getPreviewMeal(dishId);
  if (!found?.meal) notFound();
  const { place, meal } = found;
  const records = await getDietConfirmations(dishId);
  const cat = evidenceCategories(meal.evidence, records);
  const row = confirmationRow(meal.evidence);
  const words = evidenceWords(meal.evidence);
  const msg = MESSAGES[one(sp.m) ?? ""];
  const err = one(sp.e) ? (ERRORS[one(sp.e)!] ?? "That didn't work. Nothing was changed.") : null;
  // Boston local date: never ahead of the database (UTC) date, so the default is never refused as "future".
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  return (
    <>
      <UnverifiedBanner />
      {msg ? (
        <p className="callout ok" role="status" data-testid="dc-message">
          {msg}
        </p>
      ) : null}
      {err ? (
        <p className="callout stop" role="alert" data-testid="dc-error">
          {err}
        </p>
      ) : null}
      <section className="panel" style={{ marginBottom: 16 }}>
        <h2 className="h-sec" style={{ marginTop: 0 }}>
          {meal.label}
        </h2>
        <p className="s14 muted" style={{ marginTop: 0 }}>
          {place.name}
          {meal.section ? ` · ${meal.section}` : ""}
        </p>
        <p className="s14">
          {meal.evidence.ingredients ? <>Listed: {meal.evidence.ingredients.join(", ")}. </> : "No ingredients listed. "}
          <span className="muted">{words.ourReading}</span>
        </p>
        <div className="table-wrap">
          <table className="data" data-testid="dc-categories">
            <thead>
              <tr>
                <th scope="col">Claim</th>
                <th scope="col">Evidence category</th>
                <th scope="col">From</th>
              </tr>
            </thead>
            <tbody>
              {CLAIMS.map((c) => (
                <tr key={c} data-testid={`dc-category-${c}`} data-category={cat[c]}>
                  <th scope="row">{c === "vegan" ? "Vegan" : "Vegetarian"}</th>
                  <td>{CATEGORY_WORDS[cat[c]]}</td>
                  <td className="s14">
                    {cat.records[c]
                      ? `Your record of ${cat.records[c]!.obtainedOn} (${METHOD_WORDS[cat.records[c]!.method].toLowerCase()})`
                      : cat[c] === "restaurant_published"
                        ? "The restaurant's own menu"
                        : cat[c] === "ingredient_supported"
                          ? "Our reading of the listed ingredients; lists can be incomplete"
                          : cat[c] === "conflict"
                            ? row.why[0] ?? "Explicit evidence against"
                            : "Nothing documented yet"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="s14 muted" style={{ marginBottom: 0 }}>
          The categories stay separate. A record covers exactly one claim; a vegan answer is never read as vegetarian, and the restaurant&rsquo;s
          name, cuisine or the meal&rsquo;s name are never evidence. Records are private to you and never claim allergen safety.
        </p>
      </section>

      <h2 className="h-sec">Records for this meal: {records.length}</h2>
      {records.length === 0 ? (
        <div className="empty" data-testid="dc-none">
          <h3>No record yet</h3>
          <p>Record an answer only after you have it, from staff, an authorized representative or a printed statement.</p>
        </div>
      ) : (
        <ul className="stack" style={{ listStyle: "none", padding: 0 }}>
          {records.map((r) => (
            <RecordItem key={r.id} r={r} dishId={dishId} />
          ))}
        </ul>
      )}

      <section className="panel" id="record" style={{ marginTop: 16 }}>
        <h2 className="h-sec" style={{ marginTop: 0 }}>
          Record a documented answer
        </h2>
        <form action={recordDietConfirmationAction} className="stack" data-testid="dc-form">
          <input type="hidden" name="dishId" value={dishId} />
          <fieldset>
            <legend>Which claim does the answer cover?</legend>
            {CLAIMS.map((c, i) => (
              <label key={c} style={{ marginRight: 12 }}>
                <input type="radio" name="claim" value={c} required defaultChecked={i === 0} /> {c === "vegan" ? "Vegan" : "Vegetarian"}
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>What was asked about? (one or more)</legend>
            {TOPICS.map((t) => (
              <label key={t} style={{ display: "block" }}>
                <input type="checkbox" name="topics" value={t} /> {TOPIC_WORDS[t]}
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>The answer</legend>
            {ANSWERS.map((a) => (
              <label key={a} style={{ marginRight: 12 }}>
                <input type="radio" name="answer" value={a} required /> {ANSWER_WORDS[a]}
              </label>
            ))}
          </fieldset>
          <label>
            What was said or printed, in their terms
            <textarea name="answerNote" required minLength={3} maxLength={1000} rows={3} placeholder="For example: the curry uses vegetable stock and no ghee; the naan contains milk" />
          </label>
          <label>
            How you obtained it
            <select name="method" required defaultValue="">
              <option value="" disabled>
                Choose a method
              </option>
              {METHODS.map((m) => (
                <option key={m} value={m}>
                  {METHOD_WORDS[m]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Method detail (required for &ldquo;Other documented source&rdquo;)
            <input name="methodNote" maxLength={500} />
          </label>
          <label>
            Source&rsquo;s role
            <input name="sourceRole" required minLength={2} maxLength={120} placeholder="For example: shift manager, chef, owner" />
          </label>
          <label>
            Source&rsquo;s name or title (optional, private to you)
            <input name="sourceIdentity" maxLength={120} />
          </label>
          <label>
            Scope: what the answer covers
            <input name="scope" required minLength={3} maxLength={500} defaultValue={`This dish as listed, at ${place.name}`} />
          </label>
          <label>
            Limitations
            <textarea name="limitations" required minLength={3} maxLength={1000} rows={2} placeholder="For example: verbal answer only; not an allergen or cross-contact statement; recipes can change" />
          </label>
          <label>
            Date the answer was obtained
            <input type="date" name="obtainedOn" required max={today} defaultValue={today} />
          </label>
          <p className="s14 muted" style={{ margin: 0 }}>
            The record lapses after 120 days, or as soon as this dish&rsquo;s menu facts change. It cannot be edited; withdraw it and record again.
          </p>
          <div>
            <button className="btn primary" type="submit" data-testid="dc-submit">
              Record this answer
            </button>
          </div>
        </form>
      </section>
      <p className="s14 muted">
        <Link href="/places/menus/confirm">Back to meals that need confirmation</Link>
      </p>
    </>
  );
}

function RecordItem({ r, dishId }: { r: DietConfirmation; dishId: string }) {
  return (
    <li className="panel" data-testid="dc-record" data-state={r.state} data-answer={r.answer} style={{ marginBottom: 8 }}>
      <p style={{ margin: 0 }}>
        <strong>
          {ANSWER_WORDS[r.answer]} for {r.claim}
        </strong>{" "}
        <span className={`badge sm ${r.state === "current" ? "ok" : "wait"}`}>{STATE_WORDS[r.state]}</span>
      </p>
      <p className="s14" style={{ margin: "4px 0" }}>
        &ldquo;{r.answerNote}&rdquo;
      </p>
      <dl className="s14" style={{ margin: 0 }}>
        <dt className="muted">Asked about</dt>
        <dd>{r.topics.map((t) => TOPIC_WORDS[t]).join("; ")}</dd>
        <dt className="muted">Method</dt>
        <dd>
          {METHOD_WORDS[r.method]}
          {r.methodNote ? ` (${r.methodNote})` : ""}
        </dd>
        <dt className="muted">Source</dt>
        <dd>
          {r.sourceRole}
          {r.sourceIdentity ? `, ${r.sourceIdentity}` : ""}
        </dd>
        <dt className="muted">Scope</dt>
        <dd>{r.scope}</dd>
        <dt className="muted">Limitations</dt>
        <dd>{r.limitations}</dd>
        <dt className="muted">Obtained</dt>
        <dd>
          {r.obtainedOn}; lapses {r.expiresOn}
        </dd>
        {r.withdrawnReason ? (
          <>
            <dt className="muted">Withdrawn</dt>
            <dd>{r.withdrawnReason}</dd>
          </>
        ) : null}
      </dl>
      {r.state !== "withdrawn" ? (
        <form action={withdrawDietConfirmationAction} style={{ marginTop: 8 }}>
          <input type="hidden" name="dishId" value={dishId} />
          <input type="hidden" name="id" value={r.id} />
          <label className="s14">
            Reason to withdraw <input name="reason" required minLength={3} maxLength={500} />
          </label>{" "}
          <button className="btn" type="submit" data-testid="dc-withdraw">
            Withdraw
          </button>
        </form>
      ) : null}
    </li>
  );
}

export default function RecordPage({ params, searchParams }: { params: Promise<{ dishId: string }>; searchParams: Promise<RawParams> }) {
  if (!FLAGS.realCatalogPreview) notFound();
  return (
    <AppShell active="discover" realPlaces>
      <p className="eyebrow">Boston · Private preview</p>
      <h1 className="title">Dietary confirmation</h1>
      <Suspense fallback={<MealListSkeleton rows={3} />}>
        <Record params={params} searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}
