import { Suspense } from "react";
import Link from "next/link";
import { AppShell, Loading } from "@/components/app-shell";
import { correctionAction } from "@/app/social/actions";
import { Flash, SignInPrompt } from "@/components/social/bits";
import { targetHref, targetKindLabel } from "@/contracts/social";
import { formatDate, titleCase } from "@/lib/format";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { getCorrectionsQueue } from "@/server/social";
import { flagAction, startChangeAction } from "@/app/editor/actions";
import { StaffNav } from "@/components/editor/bits";
import { getStaffAlerts } from "@/server/editor";

export const metadata = { title: "Corrections" };

async function Corrections({ searchParams }: { searchParams: Promise<RawParams> }) {
  const sp = await searchParams;
  const member = await getCurrentMember();
  if (!member) {
    return (
      <SignInPrompt next="/moderation/corrections">
        <p>Sign in to continue.</p>
      </SignInPrompt>
    );
  }
  const alerts = await getStaffAlerts();
  if (!alerts?.isEditor) {
    return (
      <div className="empty" data-testid="corrections-denied">
        <h2>This page is for catalog editors</h2>
        <p>Your account doesn&rsquo;t have the curator role.</p>
      </div>
    );
  }
  const q = await getCorrectionsQueue();
  return (
    <>
      <StaffNav alerts={alerts} here="/moderation/corrections" />
      <Flash sp={sp} />
      <p className="s14 muted">
        Members send these from &ldquo;Report a problem&rdquo; on a place or dish. A decision here records what you concluded. It never changes the page. To change the page, an editor starts a change from the accepted correction, records a source, and a second person checks it. You do not see who sent a correction.
      </p>
      <h2 className="h-sec">Open ({q.open.length})</h2>
      {q.open.length === 0 ? (
        <p className="muted" data-testid="corrections-empty">
          No corrections are waiting.
        </p>
      ) : (
        <ul className="feed" data-testid="corrections-open">
          {q.open.map((c) => (
            <li className="post" key={c.correctionId}>
              <p className="kind" style={{ margin: 0 }}>
                {titleCase(c.field)} · sent {formatDate(c.at)}
              </p>
              <p className="about" style={{ marginTop: 2 }}>
                {c.target ? (
                  <>
                    <Link href={targetHref(c.target)}>{c.target.name}</Link> <span className="muted s14" style={{ fontWeight: 400 }}>· {targetKindLabel(c.target.kind)}</span>
                  </>
                ) : (
                  "This item is no longer public"
                )}
              </p>
              <p className="text">{c.proposedValue}</p>
              {c.evidenceNote && <p className="s14 muted" style={{ margin: "6px 0 0" }}>Evidence: {c.evidenceNote}</p>}
              <form action={correctionAction} className="stack" style={{ marginTop: 10 }}>
                <input type="hidden" name="return" value="/moderation/corrections" />
                <input type="hidden" name="correctionId" value={c.correctionId} />
                <div>
                  <label htmlFor={`cn-${c.correctionId}`} className="s14">
                    Note (optional, kept with the decision)
                  </label>
                  <input id={`cn-${c.correctionId}`} type="text" name="note" maxLength={300} autoComplete="off" />
                </div>
                <div className="row">
                  <button className="btn primary small" type="submit" name="state" value="accepted">
                    Accept
                  </button>
                  <button className="btn small" type="submit" name="state" value="duplicate">
                    Duplicate
                  </button>
                  <button className="btn small" type="submit" name="state" value="rejected">
                    Reject
                  </button>
                </div>
              </form>
            </li>
          ))}
        </ul>
      )}
      <h2 className="h-sec">Recently decided</h2>
      {q.decided.length === 0 ? (
        <p className="muted">Nothing decided yet.</p>
      ) : (
        <ul className="mine-list" data-testid="corrections-decided">
          {q.decided.map((c) => (
            <li key={c.correctionId}>
              <div>
                <strong>
                  {titleCase(c.state ?? "")} · {titleCase(c.field)}
                  {c.target ? ` · ${c.target.name}` : ""}
                </strong>
                <span className="s14 muted">
                  {formatDate(c.at)}
                  {c.decisionNote ? ` · ${c.decisionNote}` : ""}
                </span>
                {c.state === "accepted" && (
                  <div className="row" style={{ marginTop: 8 }} data-correction={c.correctionId}>
                    {c.appliedChangeId ? (
                      <Link className="link s14" href={`/editor/changes/${c.appliedChangeId}`}>
                        Acted on: see the published change
                      </Link>
                    ) : c.openChangeId ? (
                      <Link className="link s14" href={`/editor/changes/${c.openChangeId}`}>
                        Change in progress
                      </Link>
                    ) : c.target ? (
                      <>
                        <form action={startChangeAction}>
                          <input type="hidden" name="return" value="/moderation/corrections" />
                          <input type="hidden" name="correctionId" value={c.correctionId} />
                          {c.foodItemId ? <input type="hidden" name="foodItemId" value={c.foodItemId} /> : <input type="hidden" name="venueId" value={c.venueId ?? ""} />}
                          <button className="btn small" type="submit">
                            Start a change from this
                          </button>
                        </form>
                        {c.foodItemId && (
                          <form action={flagAction}>
                            <input type="hidden" name="return" value="/moderation/corrections" />
                            <input type="hidden" name="correctionId" value={c.correctionId} />
                            <input type="hidden" name="foodItemId" value={c.foodItemId} />
                            <input type="hidden" name="reason" value={`A member's accepted correction conflicts with the published entry (${c.field}).`} />
                            <button className="btn small" type="submit">
                              Mark as needing review
                            </button>
                          </form>
                        )}
                      </>
                    ) : (
                      <span className="s14 muted">Not yet acted on</span>
                    )}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export default function Page({ searchParams }: { searchParams: Promise<RawParams> }) {
  return (
    <AppShell active="none" narrow>
      <h1 className="title">Corrections</h1>
      <Suspense fallback={<Loading />}>
        <Corrections searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}
