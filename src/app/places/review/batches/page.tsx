import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell, Loading } from "@/components/app-shell";
import { SignInPrompt } from "@/components/social/bits";
import { FLAGS } from "@/config/flags";
import { boundPercent, type BatchStatus, type BatchSummary } from "@/contracts/review";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { getBatchSummary } from "@/server/catalog/review";
import { SocialError } from "@/server/social";
import { batchDecisionAction } from "../actions";
import { FounderOnly, Progress } from "../bits";

export const metadata = { title: "Batch review", robots: { index: false, follow: false } };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" });
const MESSAGES: Record<string, string> = {
  approved: "Batch approved. Nothing is public: public listing is a separate switch.",
  withdrawn: "Approval withdrawn. No place from this batch can be public.",
};
const ERRORS: Record<string, string> = {
  ACKNOWLEDGEMENT_REQUIRED: "Tick the box to confirm what approving does and does not do.",
  SAMPLE_NOT_PASSED: "This batch's sample has not passed the rule yet, so it cannot be approved.",
  ALREADY_APPROVED: "This batch is already approved.",
  NOT_APPROVED: "This batch is not approved, so there is nothing to withdraw.",
  FOUNDER_ONLY: "Only the founder can decide about a batch.",
};

function Confidence({ b }: { b: BatchStatus }) {
  if (b.checked === 0) return <p data-testid="batch-confidence">No sampled place has been checked yet, so there is no estimate yet.</p>;
  return (
    <p data-testid="batch-confidence">
      {b.checked < b.sampleSize ? "So far, b" : "B"}ased on {b.checked} checked {b.checked === 1 ? "place" : "places"} with {b.problems} {b.problems === 1 ? "problem" : "problems"}, we can say with
      95% confidence that <strong>no more than {boundPercent(b.upperBound)}</strong> of this batch is wrong.
    </p>
  );
}

function Batch({ b, switchOn }: { b: BatchStatus; switchOn: boolean }) {
  const needsExtension = b.checked === b.sampleSize && !b.passes && b.sampleSize < 125 && b.problems <= 2;
  return (
    <section className="post stack" data-testid="batch" aria-labelledby={`b-${b.id}`}>
      <div className="head">
        <h2 id={`b-${b.id}`} className="h-sec" style={{ margin: 0, overflowWrap: "anywhere" }}>
          Batch {b.name}
        </h2>
        <span className={`badge ${b.approved ? "ok" : "wait"}`} data-testid="batch-gate1">
          {b.approved ? "Approved by you" : b.approvalExpired ? "Approval expired" : "Not approved"}
        </span>
      </div>
      <p className="s14 muted" style={{ margin: 0 }}>
        {b.places} places that passed two-source matching and every automatic check, frozen {when(b.frozenAt)}. Sample “{b.sampleSeed}”.
      </p>
      <Progress label="Sample" done={b.checked} total={b.sampleSize} testId="batch-progress" />
      <p style={{ margin: 0 }}>
        {b.problems} {b.problems === 1 ? "problem" : "problems"} found (a place you rejected or asked more evidence for).{" "}
        <Link href="/places/review?queue=sample">Open the sample</Link>
      </p>
      <Confidence b={b} />
      <div className={`callout ${b.passes ? "calm" : ""}`} data-testid="batch-rule">
        <strong>{b.passes ? "The sample passes." : "The sample has not passed yet."}</strong> Rule: {b.rule}
        {needsExtension && " One or two problems in 61 places is not enough to approve: Claude can add places to the sample so it reaches 125."}
      </div>
      {b.excluded > 0 && (
        <p className="s14" style={{ margin: 0 }} data-testid="batch-excluded">
          {b.excluded} {b.excluded === 1 ? "place" : "places"} in this batch that you rejected or asked more evidence for can never be public through it.
        </p>
      )}
      <p className="s14 muted" style={{ margin: 0 }}>
        Approving a batch does not mark any place “checked by us”: each place keeps the label “Address from two public datasets, not yet checked by us individually”. Places you decide one by one keep your
        decision.
      </p>

      <h3 style={{ fontSize: 16, margin: "8px 0 0" }}>Two separate gates before anything is public</h3>
      <ol style={{ margin: 0, paddingLeft: 20 }} data-testid="batch-gates">
        <li>
          <strong>Your batch approval:</strong> {b.approved ? "given." : "not given."}
        </li>
        <li>
          <strong>Public listing switch:</strong> {switchOn ? "on." : "off."} It is turned on separately, only after you approve the launch, and turning it off hides every real place at once.
        </li>
      </ol>

      {!b.approved ? (
        <form action={batchDecisionAction} className="stack" data-testid="batch-approve-form">
          <input type="hidden" name="batchId" value={b.id} />
          <input type="hidden" name="decision" value="approve" />
          <label style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
            <input type="checkbox" name="acknowledged" value="yes" required disabled={!b.passes} style={{ marginTop: 4, minWidth: 20, minHeight: 20 }} />
            <span>I understand that approving this batch publishes nothing, marks no place as checked by us, and that public listing needs a separate decision.</span>
          </label>
          <div>
            <label htmlFor={`note-${b.id}`}>Note (optional)</label>
            <textarea id={`note-${b.id}`} name="note" maxLength={1000} rows={2} style={{ width: "100%" }} disabled={!b.passes} />
          </div>
          <button className="btn primary" type="submit" disabled={!b.passes} aria-describedby={b.passes ? undefined : `why-${b.id}`} data-testid="batch-approve">
            Approve this batch
          </button>
          {!b.passes && (
            <p id={`why-${b.id}`} className="s14 muted" style={{ margin: 0 }}>
              Available once every sampled place is checked and the sample passes the rule.
            </p>
          )}
        </form>
      ) : (
        <form action={batchDecisionAction} className="stack" data-testid="batch-withdraw-form">
          <input type="hidden" name="batchId" value={b.id} />
          <input type="hidden" name="decision" value="withdraw" />
          <div>
            <label htmlFor={`wnote-${b.id}`}>Note (optional)</label>
            <textarea id={`wnote-${b.id}`} name="note" maxLength={1000} rows={2} style={{ width: "100%" }} />
          </div>
          <button className="btn" type="submit" data-testid="batch-withdraw">
            Withdraw approval
          </button>
        </form>
      )}

      <h3 style={{ fontSize: 16, margin: "8px 0 0" }}>History</h3>
      {b.history.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          No decisions about this batch yet.
        </p>
      ) : (
        <ol className="feed" data-testid="batch-history">
          {b.history.map((h, i) => (
            <li key={i} className="post">
              <strong>{h.decision === "approve" ? "Approved" : "Approval withdrawn"}</strong>
              <p className="s14 muted" style={{ margin: "4px 0 0" }}>
                {h.by ?? "Founder"}, {when(h.at)}. At that time: {h.checked} of {h.sampleSize} checked, {h.problems} problems, at most {boundPercent(h.upperBound)} wrong (95% confidence).
              </p>
              {h.note && <p style={{ margin: "4px 0 0", overflowWrap: "anywhere" }}>{h.note}</p>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

async function Batches({ searchParams }: { searchParams: Promise<RawParams> }) {
  const sp = await searchParams;
  const member = await getCurrentMember();
  if (!member) {
    return (
      <SignInPrompt next="/places/review/batches">
        <p>Batch review is for the founder. Sign in to continue.</p>
      </SignInPrompt>
    );
  }
  let data: BatchSummary;
  try {
    data = await getBatchSummary();
  } catch (e) {
    if (e instanceof SocialError && (e.status === 403 || e.status === 401)) return <FounderOnly />;
    return (
      <div className="callout stop" role="alert">
        <strong>We couldn&rsquo;t load the batches just now.</strong> <Link href="/places/review/batches">Try again</Link>
      </div>
    );
  }
  const m = first(sp.m);
  const e = first(sp.e);
  return (
    <>
      {m && MESSAGES[m] && (
        <p className="callout calm" role="status" data-testid="batch-message">
          {MESSAGES[m]}
        </p>
      )}
      {e && (
        <p className="callout stop" role="alert" data-testid="batch-error">
          {ERRORS[e] ?? "That decision was not recorded. Please try again."}
        </p>
      )}
      {data.batches.length === 0 ? (
        <p className="muted">No batch has been frozen yet.</p>
      ) : (
        <div className="feed">
          {data.batches.map((b) => (
            <Batch key={b.id} b={b} switchOn={data.switchOn} />
          ))}
        </div>
      )}
    </>
  );
}

export default function BatchesPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  if (!FLAGS.realCatalogPreview) notFound();
  return (
    <AppShell active="discover" realPlaces>
      <p className="eyebrow">Private · founder only</p>
      <h1 className="title">Batch review</h1>
      <p>
        <Link href="/places/review">← Identity review</Link>
      </p>
      <Suspense fallback={<Loading label="Loading batches…" />}>
        <Batches searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}
