import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell, Loading } from "@/components/app-shell";
import { SignInPrompt } from "@/components/social/bits";
import { FLAGS } from "@/config/flags";
import { DECISION_WORDS, REASON_WORDS, REJECT_REASONS, queueWords, type ReviewItem, type ReviewSummary } from "@/contracts/review";
import { evidenceChecks, osmLink } from "@/lib/review-checks";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { getReviewItem, getReviewSummary } from "@/server/catalog/review";
import { streetFile } from "@/server/map-tiles";
import { SocialError } from "@/server/social";
import { recordDecisionAction } from "../actions";
import { FounderOnly, Progress } from "../bits";
import { EvidenceMapLoader } from "../evidence-map-loader";

export const metadata = { title: "Identity review", robots: { index: false, follow: false } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUEUE = /^[a-z0-9_]{1,60}$/;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const LETTERS = "ABCDEFGH";

const ERRORS: Record<string, string> = {
  REASON_REQUIRED: "Choose why you are rejecting this place.",
  NOTE_TOO_LONG: "The note can be at most 1,000 characters.",
  FOUNDER_ONLY: "Only the founder can record identity decisions.",
  NOT_FOUND: "This place is no longer in a review queue.",
};

const OPEN_WORDS: Record<string, string> = { open: "Open", licensed_active: "Active licence or permit", unknown: "Not stated" };

function Hidden({ item, queue }: { item: ReviewItem; queue: string }) {
  return (
    <>
      <input type="hidden" name="candidateId" value={item.candidateId} />
      <input type="hidden" name="queue" value={queue} />
      {item.next && <input type="hidden" name="next" value={item.next} />}
    </>
  );
}

function Note({ id }: { id: string }) {
  return (
    <div>
      <label htmlFor={id}>Note (optional)</label>
      <textarea id={id} name="note" maxLength={1000} rows={2} style={{ width: "100%" }} />
    </div>
  );
}

function Decide({ item, queue }: { item: ReviewItem; queue: string }) {
  return (
    <section aria-labelledby="decide-h" className="decide" data-testid="review-decide">
      <h2 id="decide-h" className="h-sec" style={{ marginBottom: 0 }}>
        Your decision about this one place
      </h2>
      <p className="s14 muted" style={{ margin: 0 }}>
        Each button records one permanent decision for this place only, then opens the next place in this queue. Nothing is published, and the menu stays “not checked”.
      </p>
      <form action={recordDecisionAction} className="stack">
        <Hidden item={item} queue={queue} />
        <input type="hidden" name="decision" value="verify_identity" />
        <button className="btn primary big" type="submit" data-testid="decide-verify">
          Identity correct
        </button>
      </form>
      <details>
        <summary>Needs more evidence</summary>
        <form action={recordDecisionAction} className="stack" style={{ marginTop: 8 }}>
          <Hidden item={item} queue={queue} />
          <input type="hidden" name="decision" value="needs_more_evidence" />
          <Note id="note-more" />
          <button className="btn" type="submit" data-testid="decide-more">
            Record: needs more evidence
          </button>
        </form>
      </details>
      <details>
        <summary>Reject</summary>
        <form action={recordDecisionAction} className="stack" style={{ marginTop: 8 }}>
          <Hidden item={item} queue={queue} />
          <input type="hidden" name="decision" value="reject" />
          <fieldset>
            <legend>Why?</legend>
            {REJECT_REASONS.map((r) => (
              <label key={r} style={{ display: "flex", gap: 8, alignItems: "center", minHeight: 44 }}>
                <input type="radio" name="reason" value={r} required /> {REASON_WORDS[r]}
              </label>
            ))}
          </fieldset>
          <Note id="note-reject" />
          <button className="btn" type="submit" data-testid="decide-reject">
            Record: reject
          </button>
        </form>
      </details>
    </section>
  );
}

/**
 * The two source records side by side (docs/57): what a quick check needs, above the decision. Nothing here is a
 * verification; the full records, the map and the look-alikes stay below.
 */
function Glance({ item }: { item: ReviewItem }) {
  const records = item.evidence.records.slice(0, 4);
  if (records.length === 0) return null;
  const rows: { label: string; value: (r: ReviewItem["evidence"]["records"][number]) => string }[] = [
    { label: "Name", value: (r) => r.name ?? "—" },
    { label: "Address", value: (r) => [r.street, r.postcode].filter(Boolean).join(", ") || "—" },
    { label: "Status", value: (r) => (r.openStatus ? (OPEN_WORDS[r.openStatus] ?? r.openStatus) : "—") + (r.present === false ? " · not in the latest release" : "") },
    { label: "Type", value: (r) => r.category ?? "—" },
    { label: "Website", value: (r) => (r.website ? r.website.replace(/^https?:\/\//, "") : "—") },
  ];
  return (
    <section aria-labelledby="glance-h" data-testid="review-glance">
      <h2 className="h-sec" id="glance-h">
        At a glance
      </h2>
      <div>
        <table className="glance">
          <caption className="sr-only">The source records for {item.name}, side by side</caption>
          <thead>
            <tr>
              <th scope="col">
                <span className="sr-only">Detail</span>
              </th>
              {records.map((r, i) => (
                <th scope="col" key={`${r.sourceKey}-${r.recordId}`}>
                  {LETTERS[i]} · {r.source ?? r.sourceKey}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                {records.map((r) => (
                  <td key={`${r.sourceKey}-${r.recordId}`} style={{ overflowWrap: "anywhere" }}>
                    {row.value(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {item.evidence.recordsApartMetres !== null && item.evidence.recordsApartMetres !== undefined && (
        <p className="s14 muted" style={{ margin: "4px 0 0" }}>
          The records are {item.evidence.recordsApartMetres} m apart.
        </p>
      )}
    </section>
  );
}

function Detail({ item, queue, summary, message, error, streetUrl }: { item: ReviewItem; queue: string; summary: ReviewSummary; message?: string; error?: string; streetUrl: string | null }) {
  const records = item.evidence.records;
  const pins = records
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.lat !== null && r.lon !== null)
    .map(({ r, i }) => ({ letter: LETTERS[i] ?? "?", lat: r.lat!, lon: r.lon!, label: `${r.source ?? r.sourceKey}: ${r.street ?? "no street"}` }));
  if (pins.length === 0) pins.push({ letter: "A", lat: item.lat, lon: item.lon, label: item.name });
  const current = item.history[0];
  const q = summary.queues.find((x) => x.queue === queue);
  const checks = evidenceChecks(item);
  return (
    <>
      <p>
        <Link href={`/places/review?queue=${queue}`}>← {queueWords(queue)}</Link>
      </p>
      {message === "recorded" && (
        <p className="callout calm" role="status" data-testid="review-message">
          Decision recorded. Here is the next place.
        </p>
      )}
      {error && (
        <p className="callout stop" role="alert" data-testid="review-error">
          {ERRORS[error] ?? "That decision was not recorded. Please try again."}
        </p>
      )}
      {queue === "sample" && summary.sample ? (
        <Progress label="Sample" done={summary.sample.checked} total={summary.sample.total} testId="review-progress" />
      ) : (
        q && <Progress label={queueWords(queue)} done={q.decided} total={q.total} testId="review-progress" />
      )}
      {queue === "sample" && summary.sample && (
        <p className="s14 muted" style={{ margin: "4px 0 0" }}>
          {summary.sample.problems} {summary.sample.problems === 1 ? "problem" : "problems"} so far.
        </p>
      )}

      <div className="head" style={{ marginTop: 16, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between" }}>
        <h2 className="title" style={{ fontSize: 24, margin: 0, overflowWrap: "anywhere" }} data-testid="review-name">
          {item.name}
        </h2>
        <span className={`badge ${current ? (current.decision === "verify_identity" ? "ok" : "stop") : "wait"}`} data-testid="review-current">
          {current ? DECISION_WORDS[current.decision] : "Not decided yet"}
        </span>
      </div>
      <p style={{ margin: "4px 0", overflowWrap: "anywhere" }}>
        {[item.street, item.postcode].filter(Boolean).join(", ") || "No address"}
        {item.area ? ` · ${item.area}` : ""}
      </p>
      <p className="s14 muted" style={{ margin: 0 }}>
        In {item.queues.length === 1 ? "queue" : "queues"}: {item.queues.map(queueWords).join(", ")}.
        {item.listing && ` Preview listing: ${item.listing.visibility === "preview" ? "in your private preview" : item.listing.visibility === "withdrawn" ? "withdrawn from the preview" : item.listing.visibility}; menu not checked yet.`}
      </p>

      {item.evidence.reasons.length > 0 && (
        <div className="callout" style={{ marginTop: 12 }} data-testid="review-reasons">
          <strong>Why it is here:</strong>
          <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>
            {item.evidence.reasons.map((r) => (
              <li key={r.code}>{r.words}</li>
            ))}
          </ul>
        </div>
      )}

      <Glance item={item} />

      <h2 className="h-sec">What the automatic checks found</h2>
      <p className={`callout ${checks.every((c) => c.ok) ? "calm" : ""}`} data-testid="review-precheck">
        {checks.every((c) => c.ok) ? (
          <>
            <strong>Pre-check: every check agrees.</strong> Compare the records above (the map and the full records are below), and confirm only if you agree. This is not a verification.
          </>
        ) : (
          <>
            <strong>Pre-check: look closer.</strong> The points marked ! below need your judgement.
          </>
        )}
      </p>
      <ul className="checks" data-testid="review-checks">
        {checks.map((c) => (
          <li key={c.text}>
            <span aria-hidden="true">{c.ok ? "✓" : "!"}</span> <span className="sr-only">{c.ok ? "Fine:" : "Look at this:"}</span> {c.text}
          </li>
        ))}
      </ul>

      {item.active ? <Decide item={item} queue={queue} /> : <p className="callout">This place has left every review queue. Its history is kept below.</p>}

      <h2 className="h-sec">Where the sources put it</h2>
      <EvidenceMapLoader pins={pins} streetUrl={streetUrl} />

      <h2 className="h-sec">Original source records</h2>
      <div className="evidence-grid" data-testid="review-records">
        {records.map((r, i) => (
          <section key={`${r.sourceKey}-${r.recordId}`} className="post" data-testid="review-record">
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span className="evidence-key" aria-hidden="true">
                {LETTERS[i]}
              </span>
              <h3 style={{ margin: 0, fontSize: 15 }}>
                <span className="sr-only">Pin {LETTERS[i]}: </span>
                {r.source ?? r.sourceKey}
              </h3>
            </div>
            <dl>
              <dt>Name</dt>
              <dd>{r.name ?? "—"}</dd>
              <dt>Address</dt>
              <dd>{[r.street, r.locality, r.postcode].filter(Boolean).join(", ") || "—"}</dd>
              <dt>Type</dt>
              <dd>{r.category ?? "—"}</dd>
              <dt>Status</dt>
              <dd>
                {r.openStatus ? (OPEN_WORDS[r.openStatus] ?? r.openStatus) : "—"}
                {r.present === false ? " · not in the latest release" : ""}
              </dd>
              <dt>Website</dt>
              <dd>{r.website ? <span>{r.website.replace(/^https?:\/\//, "")}</span> : "—"}</dd>
              <dt>Release</dt>
              <dd>{r.release ?? "—"}</dd>
              <dt>Record</dt>
              <dd className="s14">{r.recordId ?? "—"}</dd>
              <dt>Position</dt>
              <dd>
                {r.lat !== null && r.lon !== null ? (
                  <a href={osmLink(r.lat, r.lon)} target="_blank" rel="noreferrer noopener">
                    {r.lat.toFixed(5)}, {r.lon.toFixed(5)} (OpenStreetMap)
                  </a>
                ) : (
                  "—"
                )}
              </dd>
            </dl>
          </section>
        ))}
      </div>
      <p className="s14 muted">The website is shown as text only. Open it yourself if you want to check it.</p>

      {item.evidence.lookalikes.length > 0 && (
        <>
          <h2 className="h-sec">Similar names nearby</h2>
          <ul data-testid="review-lookalikes">
            {item.evidence.lookalikes.map((l, i) => (
              <li key={i}>
                {l.name}, {l.street ?? "no street"} ({l.metres} m away)
              </li>
            ))}
          </ul>
        </>
      )}

      <h2 className="h-sec">Decision history</h2>
      {item.history.length === 0 ? (
        <p className="muted" data-testid="review-history-empty">
          No decisions yet.
        </p>
      ) : (
        <ol className="feed" data-testid="review-history">
          {item.history.map((h, i) => (
            <li key={i} className="post">
              <strong>{DECISION_WORDS[h.decision]}</strong>
              {h.reason ? `: ${REASON_WORDS[h.reason]}` : ""}
              {i === 0 ? " (counts now)" : " (replaced by a later decision)"}
              <p className="s14 muted" style={{ margin: "4px 0 0" }}>
                {h.by ?? "Founder"}, {new Date(h.at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" })}, from “{queueWords(h.queue)}”
              </p>
              {h.note && <p style={{ margin: "4px 0 0", overflowWrap: "anywhere" }}>{h.note}</p>}
            </li>
          ))}
        </ol>
      )}
      <p className="s14 muted">Decisions cannot be edited or deleted. To change your mind, record a new decision; the latest one counts.</p>
    </>
  );
}

async function Item({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<RawParams> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  if (!UUID.test(id)) notFound();
  const member = await getCurrentMember();
  if (!member) {
    return (
      <SignInPrompt next={`/places/review/${id}`}>
        <p>Identity review is for the founder. Sign in to continue.</p>
      </SignInPrompt>
    );
  }
  const qRaw = first(sp.queue);
  const qParam = qRaw && QUEUE.test(qRaw) ? qRaw : undefined;
  let item: ReviewItem;
  let summary: ReviewSummary;
  try {
    [item, summary] = await Promise.all([getReviewItem(id, qParam), getReviewSummary()]);
  } catch (e) {
    if (e instanceof SocialError && (e.status === 403 || e.status === 401)) return <FounderOnly />;
    if (e instanceof SocialError && e.status === 404) notFound();
    return (
      <div className="callout stop" role="alert">
        <strong>We couldn&rsquo;t load this place just now.</strong> <Link href="/places/review">Back to the queues</Link>
      </div>
    );
  }
  const queue = qParam && item.queues.includes(qParam) ? qParam : item.queues[0];
  const street = await streetFile();
  const e = first(sp.e);
  return (
    <>
      <Detail item={item} queue={queue} summary={summary} message={first(sp.m)} error={e && /^[A-Z_]{1,40}$/.test(e) ? e : undefined} streetUrl={street ? "/map-data/streets" : null} />
      {FLAGS.partnerSubmissions && (
        <p className="s14 muted" data-testid="review-claim-link" style={{ overflowWrap: "anywhere" }}>
          Restaurant claim link for this place (give it only to someone you are in touch with at the restaurant): <code>/partner/claim/{item.candidateId}</code>
        </p>
      )}
    </>
  );
}

export default function ReviewItemPage(props: { params: Promise<{ id: string }>; searchParams: Promise<RawParams> }) {
  if (!FLAGS.realCatalogPreview) notFound();
  return (
    <AppShell active="discover" realPlaces>
      <p className="eyebrow">Private · founder only · identity review</p>
      <Suspense fallback={<Loading label="Loading this place…" />}>
        <Item {...props} />
      </Suspense>
    </AppShell>
  );
}
