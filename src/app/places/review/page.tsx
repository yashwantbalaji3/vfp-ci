import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell, Loading } from "@/components/app-shell";
import { SignInPrompt } from "@/components/social/bits";
import { FLAGS } from "@/config/flags";
import { DECISION_WORDS, queueWords, type ReviewList, type ReviewSummary } from "@/contracts/review";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { getReviewList, getReviewSummary } from "@/server/catalog/review";
import { FounderOnly, Progress } from "./bits";
import { FounderGate } from "./gate";
import { SocialError } from "@/server/social";

export const metadata = { title: "Identity review", robots: { index: false, follow: false } };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const QUEUE = /^[a-z0-9_]{1,60}$/;

/** Short words for each pre-check concern in the queue list (docs/51). */
const PRECHECK_WORDS: Record<string, string> = {
  distance: "sources far apart",
  name: "names differ",
  house_number: "house numbers",
  single_source: "one source",
  dropped: "dropped by a source",
  open_status: "open status unknown",
  lookalikes: "similar names nearby",
  shop_name: "may be a shop",
  website: "website not its own",
};

function SampleCard({ s }: { s: NonNullable<ReviewSummary["sample"]> }) {
  const share = s.checked ? Math.round((100 * s.problems) / s.checked) : 0;
  const done = s.checked === s.total && s.total > 0;
  return (
    <section className="post" data-testid="review-sample">
      <h2 className="h-sec" style={{ marginTop: 0 }}>
        Representative sample
      </h2>
      <p className="s14 muted" style={{ margin: "0 0 8px" }}>
        {s.total} places drawn fairly from every area of the preview (sample “{s.seed}”). Checking these tells you how trustworthy the whole batch is, without checking
        over 1,000 places one by one.
      </p>
      <Progress label="Sample" done={s.checked} total={s.total} testId="review-sample-progress" />
      <p style={{ margin: "8px 0" }} data-testid="review-sample-result">
        {s.correct} correct, {s.problems} {s.problems === 1 ? "problem" : "problems"}
        {s.checked ? ` (${share}% of those checked)` : ""}.{" "}
        {done ? (share <= 5 ? "The sample passes the 5% limit." : "The sample is over the 5% limit: the checks need fixing and a new sample.") : "The result counts once every place is checked."}
      </p>
      {s.precheckAgree + s.precheckLook > 0 && (
        <p className="callout calm" style={{ margin: "0 0 8px" }} data-testid="review-precheck-summary">
          <strong>Automatic pre-check:</strong> every check agrees for {s.precheckAgree} of {s.total} places; {s.precheckLook} {s.precheckLook === 1 ? "needs" : "need"} a closer
          look, marked in the list. The pre-check reads the same public records you see. It decides nothing: you still look at each place and record your own decision.
        </p>
      )}
      <p className="s14 muted" style={{ margin: "0 0 8px" }}>
        Passing the sample does not mark any place as checked by us and does not publish anything. Only your own decision on a place marks that place.
      </p>
      <p style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: 0 }}>
        <Link className="btn primary" href="/places/review?queue=sample">
          {s.checked ? "Continue the sample" : "Start the sample"}
        </Link>
        <Link className="btn" href="/places/review/batches" data-testid="review-batches-link">
          Batch result and approval
        </Link>
        <Link className="btn" href="/places/review/menus" data-testid="review-menus-link">
          Menu review
        </Link>
        <Link className="btn" href="/places/review/reports" data-testid="review-reports-link">
          Visitor reports
        </Link>
        {FLAGS.partnerSubmissions && (
          <Link className="btn" href="/places/review/partner" data-testid="review-partner-link">
            Restaurant submissions
          </Link>
        )}
      </p>
    </section>
  );
}

function Summary({ s }: { s: ReviewSummary }) {
  const others = s.queues.filter((q) => q.queue !== "sample");
  return (
    <>
      {s.sample && <SampleCard s={s.sample} />}
      <h2 className="h-sec">Places that need a person</h2>
      <p className="s14 muted" style={{ marginTop: 0 }}>
        These passed two-source matching but failed one of the automatic checks. One place can be in more than one queue.
      </p>
      <ul className="feed" data-testid="review-queues">
        {others.map((q) => (
          <li key={q.queue} className="post">
            <div className="head">
              <Link href={`/places/review?queue=${q.queue}`} style={{ fontWeight: 700 }}>
                {queueWords(q.queue)}
              </Link>
              <span className={`badge ${q.decided === q.total ? "ok" : "wait"}`}>
                {q.decided} of {q.total} decided
              </span>
            </div>
          </li>
        ))}
      </ul>
      <p className="s14 muted" data-testid="review-totals">
        Your decisions so far: {s.decisions.verified} identity correct, {s.decisions.rejected} rejected, {s.decisions.needsMoreEvidence} need more evidence. Decisions are
        permanent; a new decision on a place replaces the old one, and both stay in its history.
      </p>
    </>
  );
}

function Queue({ queue, list }: { queue: string; list: ReviewList }) {
  return (
    <>
      <p>
        <Link href="/places/review">← All queues</Link>
      </p>
      <h2 className="h-sec">{queueWords(queue)}</h2>
      <Progress label={queueWords(queue)} done={list.decided} total={list.total} testId="review-queue-progress" />
      {list.items.length === 0 ? (
        <p className="muted">Nothing in this queue.</p>
      ) : (
        <ul className="feed" style={{ marginTop: 12 }} data-testid="review-list">
          {list.items.map((i) => (
            <li key={i.candidateId} className="post" data-testid="review-row">
              <div className="head">
                <Link href={`/places/review/${i.candidateId}?queue=${queue}`} style={{ fontWeight: 700, overflowWrap: "anywhere" }}>
                  {i.name}
                </Link>
                <span className={`badge ${i.decision ? (i.decision === "verify_identity" ? "ok" : "stop") : "wait"}`}>{i.decision ? DECISION_WORDS[i.decision] : "Not decided"}</span>
              </div>
              <p className="s14 muted" style={{ margin: "4px 0 0", overflowWrap: "anywhere" }}>
                {[i.street, i.postcode, i.area].filter(Boolean).join(" · ")}
              </p>
              {i.precheck && (
                <p className="s14" style={{ margin: "4px 0 0" }} data-testid="review-row-precheck">
                  {i.precheck.level === "agree" ? "Pre-check: every check agrees" : `Pre-check: look closer (${i.precheck.concerns.map((c) => PRECHECK_WORDS[c] ?? c).join(", ")})`}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      {list.nextOffset !== null && (
        <p>
          <Link className="btn" href={`/places/review?queue=${queue}&offset=${list.nextOffset}`}>
            More places
          </Link>
        </p>
      )}
    </>
  );
}

async function Review({ searchParams }: { searchParams: Promise<RawParams> }) {
  const sp = await searchParams;
  const member = await getCurrentMember();
  if (!member) {
    return (
      <SignInPrompt next="/places/review">
        <p>Identity review is for the founder. Sign in to continue.</p>
      </SignInPrompt>
    );
  }
  const q = first(sp.queue);
  const queue = q && QUEUE.test(q) ? q : undefined;
  const offset = Math.min(Math.max(Number.parseInt(first(sp.offset) ?? "0", 10) || 0, 0), 5000);
  let data: { list: ReviewList } | { summary: ReviewSummary };
  try {
    data = queue ? { list: await getReviewList(queue, offset) } : { summary: await getReviewSummary() };
  } catch (e) {
    if (e instanceof SocialError && (e.status === 403 || e.status === 401)) return <FounderOnly />;
    return (
      <div className="callout stop" role="alert">
        <strong>We couldn&rsquo;t load the review queues just now.</strong> <Link href="/places/review">Try again</Link>
      </div>
    );
  }
  return (
    <>
      {first(sp.m) === "queue_done" && (
        <p className="callout calm" role="status" data-testid="review-message">
          Decision recorded. There are no more undecided places in this queue.
        </p>
      )}
      {"list" in data ? <Queue queue={queue!} list={data.list} /> : <Summary s={data.summary} />}
    </>
  );
}

export default function ReviewPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  if (!FLAGS.realCatalogPreview) notFound();
  return (
    <Suspense fallback={<Loading />}>
      <FounderGate probe={getReviewSummary}>
    <AppShell active="discover" realPlaces>
      <p className="eyebrow">Private · founder only</p>
      <h1 className="title">Identity review</h1>
      <p className="s14 muted" style={{ marginTop: 0 }}>
        Check that each real place exists where the public datasets say. This is about identity only: menus, diets and nutrition are checked separately, and nothing here
        makes a place public.
      </p>
      <Suspense fallback={<Loading label="Loading the review queues…" />}>
        <Review searchParams={searchParams} />
      </Suspense>
    </AppShell>
      </FounderGate>
    </Suspense>
  );
}
