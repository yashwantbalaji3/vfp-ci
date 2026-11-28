import { Suspense } from "react";
import { notFound } from "next/navigation";
import { AppShell, Loading } from "@/components/app-shell";
import { suspensionAction } from "@/app/editor/actions";
import { StaffDenied, StaffNav } from "@/components/editor/bits";
import { Flash, SignInPrompt } from "@/components/social/bits";
import type { MemberHistory } from "@/contracts/editor";
import { handleSchema } from "@/contracts/social";
import { formatDate } from "@/lib/format";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { getMemberHistory, getStaffAlerts } from "@/server/editor";
import { SocialError } from "@/server/social";

export const metadata = { title: "Member history", robots: { index: false, follow: false } };

const COUNT_WORDS: [string, string][] = [
  ["reviewsVisible", "Public reviews showing"],
  ["reviewsPending", "Reviews waiting for approval"],
  ["reviewsRemoved", "Reviews removed by a moderator"],
  ["listsPublic", "Public lists showing"],
  ["listsRemoved", "Lists removed by a moderator"],
  ["reportsAgainstOpen", "Open reports about their content"],
  ["reportsAgainstActioned", "Reports that led to a removal"],
  ["reportsAgainstDismissed", "Reports closed with no action"],
  ["reportsMade", "Reports they have sent"],
];
const EVENT_WORDS: Record<string, string> = {
  "moderation.approve": "Approved",
  "moderation.remove": "Removed",
  "moderation.restore": "Restored",
  "moderation.dismiss_report": "Reports dismissed",
  "moderation.suspend": "Account suspended",
  "moderation.reinstate": "Account reinstated",
};
const TYPE_WORDS: Record<string, string> = { review: "a review", list: "a list", ranking: "a ranking", profile: "the profile", member: "the account" };

async function History({ params, searchParams }: { params: Promise<{ handle: string }>; searchParams: Promise<RawParams> }) {
  const [{ handle: raw }, sp] = await Promise.all([params, searchParams]);
  const handle = decodeURIComponent(raw).replace(/^@/, "").toLowerCase();
  const member = await getCurrentMember();
  if (!member) {
    return (
      <SignInPrompt next={`/moderation/members/${handle}`}>
        <p>Sign in to continue.</p>
      </SignInPrompt>
    );
  }
  const alerts = await getStaffAlerts();
  if (!alerts?.isModerator) return <StaffDenied what="moderators" />;
  if (!handleSchema.safeParse(handle).success) notFound();
  let h: MemberHistory;
  try {
    h = await getMemberHistory(handle);
  } catch (e) {
    if (e instanceof SocialError && e.status === 404) notFound();
    throw e;
  }
  return (
    <>
      <StaffNav alerts={alerts} here="" />
      <Flash sp={sp} />
      <h2 className="h-sec" style={{ marginTop: 0 }} data-testid="member-name">
        {h.displayName ?? h.handle} <span className="muted s14" style={{ fontWeight: 400 }}>@{h.handle}</span>
      </h2>
      <p className="s14 muted">
        This page shows only what a moderator needs: public content counts and past decisions. A member&rsquo;s diary, goals, cooking, plans, saved items and email address are never shown here.
      </p>
      <p className="row">
        {h.suspendedAt ? <span className="badge stop" data-testid="member-suspended">Suspended {formatDate(h.suspendedAt)}</span> : <span className="badge ok" data-testid="member-active">In good standing</span>}
        {h.profileHiddenAt && <span className="badge wait">Profile hidden</span>}
        {!h.firstPublicApprovedAt && <span className="badge wait">No approved public post yet</span>}
        {h.isStaff && <span className="badge">Staff account</span>}
        {h.isDemo && <span className="badge">Demo account</span>}
      </p>
      {h.suspendedReason && <p className="s14">Reason given: {h.suspendedReason}</p>}

      <h2 className="h-sec">Counts</h2>
      <dl className="s14" data-testid="member-counts" style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "4px 16px", margin: 0 }}>
        {COUNT_WORDS.map(([key, label]) => (
          <div key={key} style={{ display: "contents" }}>
            <dt>{label}</dt>
            <dd style={{ margin: 0, fontWeight: 700 }}>{h.counts[key] ?? 0}</dd>
          </div>
        ))}
      </dl>

      <h2 className="h-sec">Past decisions</h2>
      {h.events.length === 0 ? (
        <p className="muted">No moderator has made a decision about this member.</p>
      ) : (
        <ol className="s14" data-testid="member-events" style={{ paddingLeft: 20 }}>
          {h.events.map((e, i) => (
            <li key={i}>
              {EVENT_WORDS[e.action] ?? e.action}: {TYPE_WORDS[e.type] ?? e.type} · {formatDate(e.at)}
              {e.by ? ` · by ${e.by}` : ""}
              {e.reason ? ` · ${e.reason}` : ""}
            </li>
          ))}
        </ol>
      )}

      <h2 className="h-sec">{h.suspendedAt ? "Reinstate" : "Suspend"}</h2>
      <form action={suspensionAction} className="stack panel" data-testid="suspension-form">
        <input type="hidden" name="return" value={`/moderation/members/${h.handle}`} />
        <input type="hidden" name="handle" value={h.handle} />
        <input type="hidden" name="suspend" value={h.suspendedAt ? "0" : "1"} />
        <p className="s14 muted">
          {h.suspendedAt
            ? "Reinstating shows their public content again and lets them post."
            : "Suspending hides their public profile, reviews, lists and ranking, takes their ratings out of the averages, and stops them posting or following. Their private diary and account are untouched, and nothing is deleted."}
        </p>
        <div>
          <label htmlFor="reason">{h.suspendedAt ? "Reason (optional)" : "Reason (kept with the decision)"}</label>
          <input id="reason" name="reason" type="text" maxLength={300} required={!h.suspendedAt} autoComplete="off" />
        </div>
        <button className={h.suspendedAt ? "btn" : "btn danger"} type="submit">
          {h.suspendedAt ? "Reinstate this account" : "Suspend this account"}
        </button>
      </form>
    </>
  );
}

export default function MemberHistoryPage({ params, searchParams }: { params: Promise<{ handle: string }>; searchParams: Promise<RawParams> }) {
  return (
    <AppShell active="none" narrow>
      <h1 className="title">Member history</h1>
      <Suspense fallback={<Loading />}>
        <History params={params} searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}
