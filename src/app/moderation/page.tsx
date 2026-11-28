import { Suspense } from "react";
import Link from "next/link";
import { AppShell, Loading } from "@/components/app-shell";
import { moderateAction } from "@/app/social/actions";
import { Flash, PersonRow, SignInPrompt, Stars } from "@/components/social/bits";
import { REPORT_REASON_LABELS, targetKindLabel, type ModerationTarget } from "@/contracts/social";
import { formatDate } from "@/lib/format";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { getModerationQueue, getMyProfile } from "@/server/social";
import { StaffNav } from "@/components/editor/bits";
import { getStaffAlerts } from "@/server/editor";

export const metadata = { title: "Moderation" };
const TYPE_WORDS: Record<string, string> = { review: "Review", list: "List", ranking: "Ranking", profile: "Profile" };
const ACTION_WORDS: Record<string, string> = {
  "moderation.approve": "Approved",
  "moderation.remove": "Removed",
  "moderation.restore": "Restored",
  "moderation.dismiss_report": "Reports dismissed",
};

/** What the moderator needs to judge one item: its words and its author. Nothing private. */
function Item({ t }: { t: ModerationTarget }) {
  return (
    <>
      <div className="head">
        {t.author ? <PersonRow person={t.author} /> : <span className="muted">Unknown author</span>}
        <span className="badge">
          {TYPE_WORDS[t.type]} · {t.audience === "friends" ? "friends only" : t.audience}
        </span>
      </div>
      {t.author && (
        <p className="s13" style={{ margin: "6px 0 0" }}>
          <Link className="link" href={`/moderation/members/${t.author.handle}`}>
            History of @{t.author.handle}
          </Link>
        </p>
      )}
      {t.firstPost && t.type !== "profile" && <p className="s13" style={{ margin: "6px 0 0" }}><span className="badge wait">This member has no approved public post yet</span></p>}
      {t.target && (
        <p className="about">
          <span className="kind">{targetKindLabel(t.target.kind)}</span>
          <br />
          {t.target.name}
          {t.target.venueName ? ` at ${t.target.venueName}` : ""}
        </p>
      )}
      {typeof t.rating === "number" && (
        <p style={{ margin: "6px 0 0" }}>
          <Stars rating={t.rating} />
        </p>
      )}
      {t.title && <p className="about">{t.title}</p>}
      {t.body ? <p className="text">{t.body}</p> : t.type === "review" ? <p className="text muted">(rating only, no text)</p> : null}
      {t.items && t.items.length > 0 && (
        <ol className="s14" style={{ margin: "6px 0 0", paddingLeft: 20 }}>
          {t.items.map((i) => (
            <li key={i.itemId}>
              {i.target.name}
              {i.note ? `: ${i.note}` : ""}
            </li>
          ))}
        </ol>
      )}
      {t.entries && t.entries.length > 0 && (
        <ol className="s14" style={{ margin: "6px 0 0", paddingLeft: 20 }}>
          {t.entries.map((e) => (
            <li key={e.venueId}>{e.name}</li>
          ))}
        </ol>
      )}
    </>
  );
}

function Decide({ t, actions, reportId }: { t: ModerationTarget; actions: ("approve" | "remove" | "restore" | "dismiss")[]; reportId?: string }) {
  const key = `${t.type}-${t.id}`;
  return (
    <form action={moderateAction} className="stack" style={{ marginTop: 10 }}>
      <input type="hidden" name="return" value="/moderation" />
      <input type="hidden" name="type" value={t.type} />
      <input type="hidden" name="id" value={t.id} />
      {reportId && <input type="hidden" name="reportId" value={reportId} />}
      <div>
        <label htmlFor={`why-${key}`} className="s14">
          Reason (needed to remove; kept in the audit log)
        </label>
        <input id={`why-${key}`} type="text" name="reason" maxLength={300} autoComplete="off" />
      </div>
      <div className="row">
        {actions.includes("approve") && (
          <button className="btn primary small" type="submit" name="action" value="approve">
            Approve
          </button>
        )}
        {actions.includes("restore") && (
          <button className="btn primary small" type="submit" name="action" value="restore">
            Restore
          </button>
        )}
        {actions.includes("dismiss") && (
          <button className="btn small" type="submit" name="action" value="dismiss">
            Keep it and close reports
          </button>
        )}
        {actions.includes("remove") && (
          <button className="btn small danger" type="submit" name="action" value="remove">
            {t.type === "profile" ? "Hide profile" : "Remove"}
          </button>
        )}
      </div>
    </form>
  );
}

async function Queue({ searchParams }: { searchParams: Promise<RawParams> }) {
  const sp = await searchParams;
  const member = await getCurrentMember();
  if (!member) {
    return (
      <SignInPrompt next="/moderation">
        <p>Sign in to continue.</p>
      </SignInPrompt>
    );
  }
  const me = await getMyProfile();
  if (!me.isModerator) {
    return (
      <div className="empty" data-testid="moderation-denied">
        <h2>This page is for moderators</h2>
        <p>Your account doesn&rsquo;t have the moderator role.</p>
        {me.isCurator && (
          <p>
            <Link className="btn" href="/moderation/corrections">
              Go to corrections
            </Link>
          </p>
        )}
      </div>
    );
  }
  const [q, alerts] = await Promise.all([getModerationQueue(), getStaffAlerts()]);
  return (
    <>
      {alerts && <StaffNav alerts={alerts} here="/moderation" />}
      <Flash sp={sp} />
      {alerts && (alerts.repeatedReports ?? 0) > 0 && (
        <p className="callout" role="status" data-testid="alert-repeated-reports">
          {alerts.repeatedReports === 1 ? "One item has" : `${alerts.repeatedReports} items have`} been reported by three or more people. Look at {alerts.repeatedReports === 1 ? "it" : "those"} first.
        </p>
      )}
      <form method="get" action="/moderation/members" className="row" role="search" style={{ marginBottom: 12 }}>
        <label htmlFor="member-handle" className="s14">
          Look up a member by handle
        </label>
        <input id="member-handle" name="handle" type="text" maxLength={31} autoComplete="off" style={{ flex: "1 1 160px" }} />
        <button className="btn small" type="submit">
          Show history
        </button>
      </form>
      <p className="s14 muted">
        You see only what was posted or reported, and who wrote it. You never see anyone&rsquo;s diary, goals, foods, plans or cooking. Every decision is recorded. You cannot decide on your own posts.
      </p>
      {me.isCurator && (
        <p>
          <Link className="link" href="/moderation/corrections">
            Corrections to places and dishes
          </Link>
        </p>
      )}

      <section aria-labelledby="pending-h" data-testid="mod-pending">
        <h2 className="h-sec" id="pending-h">
          Waiting for a first check ({q.pending.length})
        </h2>
        <p className="s14 muted" style={{ marginTop: 0 }}>
          Approving one post publishes that post only. The member&rsquo;s other waiting posts stay here until each is approved.
        </p>
        {q.pending.length === 0 ? (
          <p className="muted">Nothing is waiting.</p>
        ) : (
          <ul className="feed">
            {q.pending.map((t) => (
              <li className="post" key={`${t.type}-${t.id}`} data-testid="mod-item">
                <Item t={t} />
                <Decide t={t} actions={["approve", "remove"]} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="reports-h" data-testid="mod-reports">
        <h2 className="h-sec" id="reports-h">
          Reports ({q.reports.length})
        </h2>
        {q.reports.length === 0 ? (
          <p className="muted">No open reports.</p>
        ) : (
          <ul className="feed">
            {q.reports.map((r) => (
              <li className="post" key={r.reportId} data-testid="mod-report">
                <p style={{ margin: "0 0 8px" }}>
                  <span className="badge wait">{REPORT_REASON_LABELS[r.reason]}</span>{" "}
                  <span className="s13 muted">
                    {r.sameTargetCount} {r.sameTargetCount === 1 ? "report" : "reports"} · first on {formatDate(r.at)}
                  </span>
                </p>
                {r.details && <p className="s14" style={{ margin: "0 0 8px" }}>Reporter&rsquo;s note: {r.details}</p>}
                {r.target ? (
                  <>
                    <Item t={r.target} />
                    <Decide t={r.target} actions={r.target.state === "removed" ? ["dismiss"] : ["dismiss", "remove"]} reportId={r.reportId} />
                  </>
                ) : (
                  <form action={moderateAction}>
                    <input type="hidden" name="return" value="/moderation" />
                    <input type="hidden" name="reportId" value={r.reportId} />
                    <p className="muted">The reported item no longer exists (its author deleted it or their account).</p>
                    <button className="btn small" type="submit" name="action" value="dismiss">
                      Close reports
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="removed-h" data-testid="mod-removed">
        <h2 className="h-sec" id="removed-h">
          Removed or hidden
        </h2>
        {q.removed.filter(Boolean).length === 0 ? (
          <p className="muted">Nothing is removed.</p>
        ) : (
          <ul className="feed">
            {q.removed.map(
              (t) =>
                t && (
                  <li className="post" key={`${t.type}-${t.id}`}>
                    <Item t={t} />
                    <Decide t={t} actions={["restore"]} />
                  </li>
                ),
            )}
          </ul>
        )}
      </section>

      <section aria-labelledby="log-h" data-testid="mod-log">
        <h2 className="h-sec" id="log-h">
          Recent decisions
        </h2>
        {q.log.length === 0 ? (
          <p className="muted">No decisions yet.</p>
        ) : (
          <ul className="mine-list">
            {q.log.map((l, i) => (
              <li key={i}>
                <div>
                  <strong>
                    {ACTION_WORDS[l.action] ?? l.action} · {TYPE_WORDS[l.type] ?? l.type}
                  </strong>
                  <span className="s14 muted">
                    {formatDate(l.at)}
                    {l.reason ? ` · ${l.reason}` : ""}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

export default function Page({ searchParams }: { searchParams: Promise<RawParams> }) {
  return (
    <AppShell active="none" narrow>
      <h1 className="title">Moderation</h1>
      <Suspense fallback={<Loading />}>
        <Queue searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}
