import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell, Loading } from "@/components/app-shell";
import { SignInPrompt } from "@/components/social/bits";
import { FLAGS } from "@/config/flags";
import { CLAIM_STATE_WORDS, type MyClaim } from "@/contracts/partner";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { getMyClaims } from "@/server/partner";
import { withdrawAction } from "./actions";
import { partnerError } from "./words";

export const metadata = { title: "Your restaurant", robots: { index: false, follow: false } };
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const count = (v: string | undefined) => Math.max(0, Number.parseInt(v ?? "0", 10) || 0);

function Claim({ c }: { c: MyClaim }) {
  const waiting = c.dishes - c.verified - c.rejected;
  return (
    <li className="post" data-testid="partner-claim">
      <div className="head">
        <strong style={{ overflowWrap: "anywhere" }}>{c.placeName}</strong>
        <span className={`badge ${c.state === "verified" ? "ok" : c.state === "pending" ? "wait" : "stop"}`} data-testid="partner-claim-state">
          {CLAIM_STATE_WORDS[c.state]}
        </span>
      </div>
      <p className="s14 muted" style={{ margin: "4px 0 8px", overflowWrap: "anywhere" }}>
        {[c.placeStreet, `You: ${c.roleTitle}`, c.contactEmail].filter(Boolean).join(" · ")}
      </p>
      {c.state === "pending" && (
        <p className="s14" style={{ margin: "0 0 8px" }}>
          A moderator will check that you represent this restaurant, for example by emailing an address at the restaurant&rsquo;s own website or calling its public
          number. You can send a menu once that is done.
        </p>
      )}
      <p className="s14" style={{ margin: "0 0 8px" }} data-testid="partner-claim-counts">
        {c.dishes === 0
          ? "No dishes sent yet."
          : `${c.dishes} ${c.dishes === 1 ? "dish" : "dishes"} sent: ${c.verified} checked by a moderator, ${c.rejected} not accepted, ${waiting} waiting. None is shown publicly.`}
      </p>
      {c.state === "verified" && (
        <p style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "0 0 8px" }}>
          <Link className="btn primary" href={`/partner/${c.claimId}/upload`} data-testid="partner-upload-link">
            Send a menu
          </Link>
        </p>
      )}
      {c.state !== "withdrawn" && (
        <details>
          <summary>Stop sharing this restaurant&rsquo;s menu</summary>
          <form action={withdrawAction} className="stack" style={{ marginTop: 8 }}>
            <input type="hidden" name="claimId" value={c.claimId} />
            <div>
              <label htmlFor={`reason-${c.claimId}`}>Reason (optional)</label>
              <input id={`reason-${c.claimId}`} name="reason" maxLength={500} style={{ width: "100%", minHeight: 44 }} />
            </div>
            <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
              <input type="checkbox" name="confirm" value="yes" required />
              <span>I understand that nothing from this claim will be used from now on, and this can&rsquo;t be undone.</span>
            </label>
            <button className="btn" type="submit" data-testid="partner-withdraw">
              Withdraw
            </button>
          </form>
        </details>
      )}
    </li>
  );
}

async function Claims({ searchParams }: { searchParams: Promise<RawParams> }) {
  const sp = await searchParams;
  const member = await getCurrentMember();
  if (!member) {
    return (
      <SignInPrompt next="/partner">
        <p>Sign in to see the restaurants you manage.</p>
      </SignInPrompt>
    );
  }
  let claims: MyClaim[];
  try {
    claims = await getMyClaims();
  } catch {
    return (
      <div className="callout stop" role="alert">
        <strong>We couldn&rsquo;t load your restaurants just now.</strong> <Link href="/partner">Try again</Link>
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
      {m === "claimed" && (
        <p className="callout calm" role="status" data-testid="partner-message">
          Thank you. Your request is saved. A moderator will check that you represent the restaurant before anything you send is used.
        </p>
      )}
      {m === "submitted" && (
        <p className="callout calm" role="status" data-testid="partner-message">
          Thank you. {count(first(sp.dishes))} {count(first(sp.dishes)) === 1 ? "dish was" : "dishes were"} received for review
          {count(first(sp.flagged)) > 0 ? `; ${count(first(sp.flagged))} ${count(first(sp.flagged)) === 1 ? "has" : "have"} a note for the moderator to look at` : ""}
          {count(first(sp.unmapped)) > 0
            ? `; ${count(first(sp.unmapped))} ${count(first(sp.unmapped)) === 1 ? "label was" : "labels were"} kept for a person to read`
            : ""}
          . Nothing is shown publicly until it is reviewed and
          published.
        </p>
      )}
      {m === "withdrawn" && (
        <p className="callout calm" role="status" data-testid="partner-message">
          Withdrawn. Nothing from that claim will be used from now on.
        </p>
      )}
      {claims.length === 0 ? (
        <div className="empty" data-testid="partner-empty">
          <h2>No restaurants yet</h2>
          <p>To manage a restaurant, open the claim link you were given for it.</p>
        </div>
      ) : (
        <ul className="feed" data-testid="partner-claims">
          {claims.map((c) => (
            <Claim key={c.claimId} c={c} />
          ))}
        </ul>
      )}
    </>
  );
}

export default function PartnerPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  if (!FLAGS.partnerSubmissions) notFound();
  return (
    <AppShell active="account">
      <p className="eyebrow">Private · for restaurants</p>
      <h1 className="title">Your restaurant</h1>
      <p className="s14 muted" style={{ marginTop: 0 }}>
        Share your own menu facts, ingredients, allergens and dietary labels with us. A moderator checks every dish before anything is used, and you can stop at any time.
      </p>
      <Suspense fallback={<Loading label="Loading your restaurants…" />}>
        <Claims searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}
