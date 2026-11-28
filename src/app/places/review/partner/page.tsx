import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell, Loading } from "@/components/app-shell";
import { SignInPrompt } from "@/components/social/bits";
import { FLAGS } from "@/config/flags";
import {
  CHECK_METHODS, CHECK_METHOD_WORDS, CLAIM_STATE_WORDS, FLAG_WORDS, NUTRIENT_WORDS, type ClaimOverview, type QueueItem,
} from "@/contracts/partner";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { getClaimsOverview, getModerationQueue } from "@/server/partner";
import { SocialError } from "@/server/social";
import { recordCheckAction, reviewDishAction } from "../../../partner/actions";
import { partnerError } from "../../../partner/words";
import { FounderOnly } from "../bits";

export const metadata = { title: "Restaurant submissions", robots: { index: false, follow: false } };
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const MESSAGES: Record<string, string> = {
  check_recorded: "Ownership check recorded.",
  dish_verified: "Dish marked as checked. It is still not published.",
  dish_rejected: "Dish not accepted.",
};
const date = (iso: string) => iso.slice(0, 10);

function ClaimRow({ c }: { c: ClaimOverview }) {
  const formId = `check-${c.claimId}`;
  return (
    <li className="post" data-testid="partner-mod-claim">
      <div className="head">
        <strong style={{ overflowWrap: "anywhere" }}>{c.placeName}</strong>
        <span className={`badge ${c.state === "verified" ? "ok" : c.state === "pending" ? "wait" : "stop"}`}>{CLAIM_STATE_WORDS[c.state]}</span>
      </div>
      <p className="s14 muted" style={{ margin: "4px 0", overflowWrap: "anywhere" }}>
        {[c.placeStreet, `${c.roleTitle} · ${c.contactEmail}`, `asked ${date(c.createdAt)}`].filter(Boolean).join(" · ")}
      </p>
      {c.latestCheck && (
        <p className="s14" style={{ margin: "0 0 8px", overflowWrap: "anywhere" }}>
          Last check ({date(c.latestCheck.checkedAt)}): {CHECK_METHOD_WORDS[c.latestCheck.method]}, {c.latestCheck.outcome}. &ldquo;{c.latestCheck.evidence}&rdquo;
        </p>
      )}
      {c.own ? (
        <p className="s14 muted" style={{ margin: 0 }}>
          This is your own claim, so another moderator has to check it.
        </p>
      ) : c.state === "withdrawn" ? null : (
        <details>
          <summary>Record an ownership check</summary>
          <form action={recordCheckAction} className="stack" style={{ marginTop: 8 }} data-testid="partner-check-form">
            <input type="hidden" name="claimId" value={c.claimId} />
            <fieldset>
              <legend>How did you check?</legend>
              {CHECK_METHODS.map((m) => (
                <label key={m} style={{ display: "flex", gap: 8, alignItems: "center", minHeight: 44 }}>
                  <input type="radio" name="method" value={m} required /> {CHECK_METHOD_WORDS[m]}
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend>Result</legend>
              {(["passed", "failed", "revoked"] as const).map((o) => (
                <label key={o} style={{ display: "flex", gap: 8, alignItems: "center", minHeight: 44 }}>
                  <input type="radio" name="outcome" value={o} required />{" "}
                  {o === "passed" ? "They represent the restaurant" : o === "failed" ? "Could not confirm" : "No longer represents the restaurant"}
                </label>
              ))}
            </fieldset>
            <div>
              <label htmlFor={formId}>What you did and what you saw</label>
              <textarea id={formId} name="evidence" required minLength={5} maxLength={1000} rows={3} style={{ width: "100%" }} />
            </div>
            <button className="btn primary" type="submit" data-testid="partner-check-send">
              Record check
            </button>
          </form>
        </details>
      )}
    </li>
  );
}

function Dish({ d }: { d: QueueItem }) {
  const nutrients = Object.entries(d.nutrition);
  const noteId = `note-${d.itemId}`;
  return (
    <li className="post" data-testid="partner-dish">
      <div className="head">
        <strong style={{ overflowWrap: "anywhere" }}>{d.name}</strong>
        <span className="badge wait">Not reviewed</span>
      </div>
      <p className="s14 muted" style={{ margin: "4px 0", overflowWrap: "anywhere" }}>
        {[d.placeName, d.section, d.priceUsd !== null ? `$${d.priceUsd.toFixed(2)}` : null].filter(Boolean).join(" · ")}
      </p>
      {d.flags.length > 0 && (
        <ul className="callout stop s14" style={{ margin: "8px 0", paddingLeft: 24 }} data-testid="partner-dish-flags">
          {d.flags.map((f) => (
            <li key={f}>{FLAG_WORDS[f] ?? f}</li>
          ))}
        </ul>
      )}
      <dl className="s14" style={{ margin: "8px 0", overflowWrap: "anywhere" }}>
        <dt>
          <strong>The restaurant&rsquo;s dietary statement</strong>
        </dt>
        <dd style={{ margin: "0 0 6px" }} data-testid="partner-dish-dietary">
          {d.dietary.length ? d.dietary.map((x) => `${x.claim}: “${x.words}”`).join("; ") : "None given"}
        </dd>
        <dt>
          <strong>Ingredients</strong>
        </dt>
        <dd style={{ margin: "0 0 6px" }}>{d.ingredients ?? "Not given"}</dd>
        <dt>
          <strong>Allergens</strong>
        </dt>
        <dd style={{ margin: "0 0 6px" }}>{d.allergens ?? "Not given"}</dd>
        <dt>
          <strong>Cross-contact</strong>
        </dt>
        <dd style={{ margin: "0 0 6px" }}>{d.crossContact ?? "Not given"}</dd>
        <dt>
          <strong>Serving</strong>
        </dt>
        <dd style={{ margin: "0 0 6px" }}>{[d.serving, d.servingGrams !== null ? `${d.servingGrams} g` : null].filter(Boolean).join(", ") || "Not given"}</dd>
        <dt>
          <strong>Nutrition (as the restaurant gave it)</strong>
        </dt>
        <dd style={{ margin: "0 0 6px" }} data-testid="partner-dish-nutrition">
          {nutrients.length
            ? nutrients.map(([k, v]) => `${NUTRIENT_WORDS[k] ?? k} ${v.amount} ${v.unit} per ${v.per === "100g" ? "100 g" : "serving"}`).join("; ")
            : "None given (unknown, not zero)"}
        </dd>
        <dt>
          <strong>Where it came from</strong>
        </dt>
        <dd style={{ margin: 0 }} data-testid="partner-dish-provenance">
          Sent by {d.claimantEmail} on {date(d.submittedAt)}
          {d.ownership ? `; ownership checked ${date(d.ownership.checkedAt)} (${CHECK_METHOD_WORDS[d.ownership.method].toLowerCase()})` : ""}; file {d.fileName ?? "(no name)"}
          {d.documentDate ? ` dated ${d.documentDate}` : ""}, fingerprint {d.fileSha256.slice(0, 12)}; permission version {d.licenceVersion}.
        </dd>
      </dl>
      <form action={reviewDishAction} className="stack">
        <input type="hidden" name="itemId" value={d.itemId} />
        <div>
          <label htmlFor={noteId}>Note (optional)</label>
          <input id={noteId} name="note" maxLength={500} style={{ width: "100%", minHeight: 44 }} />
        </div>
        <p style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: 0 }}>
          <button className="btn primary" type="submit" name="decision" value="verified" data-testid="partner-dish-verify">
            Checked: matches the restaurant&rsquo;s information
          </button>
          <button className="btn" type="submit" name="decision" value="rejected" data-testid="partner-dish-reject">
            Not accepted
          </button>
        </p>
      </form>
    </li>
  );
}

async function Moderation({ searchParams }: { searchParams: Promise<RawParams> }) {
  const sp = await searchParams;
  const member = await getCurrentMember();
  if (!member) {
    return (
      <SignInPrompt next="/places/review/partner">
        <p>Restaurant submissions are for moderators. Sign in to continue.</p>
      </SignInPrompt>
    );
  }
  let claims: ClaimOverview[];
  let queue: QueueItem[];
  try {
    [claims, queue] = await Promise.all([getClaimsOverview(), getModerationQueue()]);
  } catch (e) {
    if (e instanceof SocialError && (e.status === 403 || e.status === 401)) return <FounderOnly />;
    return (
      <div className="callout stop" role="alert">
        <strong>We couldn&rsquo;t load restaurant submissions just now.</strong> <Link href="/places/review/partner">Try again</Link>
      </div>
    );
  }
  const m = first(sp.m);
  const err = partnerError(first(sp.e));
  return (
    <>
      {err && (
        <p className="callout stop" role="alert" data-testid="partner-error">
          {err}
        </p>
      )}
      {m && MESSAGES[m] && (
        <p className="callout calm" role="status" data-testid="partner-message">
          {MESSAGES[m]}
        </p>
      )}
      <h2 className="h-sec">Restaurant claims ({claims.length})</h2>
      <p className="s14 muted" style={{ marginTop: 0 }}>
        Check ownership outside the app, then record what you did. Prefer a reply from an address at the restaurant&rsquo;s own website domain, or a call to the number in the
        public records. A claim link for a place is <code>/partner/claim/</code> followed by the place&rsquo;s id, shown on its review page.
      </p>
      {claims.length === 0 ? (
        <p className="muted">No claims yet.</p>
      ) : (
        <ul className="feed" data-testid="partner-mod-claims">
          {claims.map((c) => (
            <ClaimRow key={c.claimId} c={c} />
          ))}
        </ul>
      )}
      <h2 className="h-sec">Dishes waiting for review ({queue.length})</h2>
      <p className="s14 muted" style={{ marginTop: 0 }}>
        Each dish is shown in the restaurant&rsquo;s own words. Automatic notes only point things out; they never change anything. Marking a dish as checked does not
        publish it.
      </p>
      {queue.length === 0 ? (
        <p className="muted" data-testid="partner-queue-empty">
          Nothing is waiting.
        </p>
      ) : (
        <ul className="feed" data-testid="partner-queue">
          {queue.map((d) => (
            <Dish key={d.itemId} d={d} />
          ))}
        </ul>
      )}
    </>
  );
}

export default function PartnerModerationPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  if (!FLAGS.partnerSubmissions || !FLAGS.realCatalogPreview) notFound();
  return (
    <AppShell active="discover" realPlaces>
      <p className="eyebrow">Private · moderators only</p>
      <h1 className="title">Restaurant submissions</h1>
      <p className="s14 muted" style={{ marginTop: 0 }}>
        Claims from restaurants and the dishes they sent. Nobody can check their own claim or review a place they have claimed. Nothing here is public.
      </p>
      <Suspense fallback={<Loading label="Loading restaurant submissions…" />}>
        <Moderation searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}
