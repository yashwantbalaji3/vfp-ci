import Link from "next/link";
import { STATE_LABELS, type ChangeSummary, type FreshnessMark, type StaffAlerts } from "@/contracts/editor";
import { formatDate } from "@/lib/format";

/** Shown to a signed-in person who does not hold the role a staff page needs. */
export function StaffDenied({ what }: { what: string }) {
  return (
    <div className="empty" data-testid="staff-denied">
      <h2>This page is for {what}</h2>
      <p>Your account doesn&rsquo;t have that role.</p>
    </div>
  );
}

/** Everything entered in R2 is practice data. Said in words on every editor page. */
export function PracticeNote() {
  return (
    <p className="callout" data-testid="practice-note">
      Practice mode. Everything entered here is marked as demo data and is never shown as a real place or dish.
    </p>
  );
}

export function StaffNav({ alerts, here }: { alerts: StaffAlerts; here: string }) {
  const links: { href: string; label: string; n?: number; show: boolean }[] = [
    { href: "/editor", label: "Editors' desk", n: (alerts.awaitingCheck ?? 0) + (alerts.myDrafts ?? 0), show: alerts.isEditor },
    { href: "/editor/items", label: "Find a record", show: alerts.isEditor },
    { href: "/editor/new", label: "Enter something new", show: alerts.isEditor },
    { href: "/moderation/corrections", label: "Corrections", n: alerts.openCorrections, show: alerts.isEditor },
    { href: "/moderation", label: "Moderation", n: (alerts.pendingPosts ?? 0) + (alerts.openReports ?? 0), show: alerts.isModerator },
  ];
  return (
    <nav aria-label="Staff pages" className="row s14" data-testid="staff-nav" style={{ marginBottom: 12 }}>
      {links
        .filter((l) => l.show)
        .map((l) => (
          <Link key={l.href} className="link" href={l.href} aria-current={l.href === here ? "page" : undefined} style={{ fontWeight: l.href === here ? 700 : 400 }}>
            {l.label}
            {l.n ? ` (${l.n})` : ""}
          </Link>
        ))}
    </nav>
  );
}

export function StateBadge({ state }: { state: string }) {
  const tone = state === "published" ? "ok" : state === "rejected" ? "stop" : state === "submitted" ? "wait" : "";
  return <span className={`badge ${tone}`}>{STATE_LABELS[state] ?? state}</span>;
}

export function ChangeList({ changes, empty, testid }: { changes: ChangeSummary[]; empty: string; testid: string }) {
  if (changes.length === 0) return <p className="muted">{empty}</p>;
  return (
    <ul className="feed" data-testid={testid}>
      {changes.map((c) => (
        <li className="post" key={c.changeId}>
          <div className="head">
            <Link className="link" href={`/editor/changes/${c.changeId}`} style={{ fontWeight: 700 }}>
              {c.target.name ?? "Unnamed"}
            </Link>
            <StateBadge state={c.state} />
          </div>
          <p className="s14 muted" style={{ margin: "4px 0 0" }}>
            {c.isNew ? "New " : "Change to a "}
            {c.target.kind === "venue" ? "place" : (c.target.kind ?? "record")}
            {c.target.venueName ? ` at ${c.target.venueName}` : ""}
            {c.fromCorrection ? " · from a member's correction" : ""}
          </p>
          {c.summary && <p className="text">{c.summary}</p>}
          <p className="s13 muted" style={{ margin: "6px 0 0" }}>
            Entered by {c.authorIsMe ? "you" : (c.author ?? "someone who has left")}
            {c.reviewer ? ` · checked by ${c.reviewer}` : ""}
            {c.reviewedAt ? ` on ${formatDate(c.reviewedAt)}` : c.submittedAt ? ` · sent ${formatDate(c.submittedAt)}` : ""}
          </p>
        </li>
      ))}
    </ul>
  );
}

/**
 * The public label for a record that is older than the agreed age, or that an
 * editor has marked as needing review. Words, not colour alone.
 */
export function FreshnessNote({ mark, what = "entry" }: { mark?: FreshnessMark; what?: string }) {
  if (!mark) return null;
  if (mark.underReview) {
    return (
      <span className="badge wait" data-testid="under-review">
        Being re-checked
      </span>
    );
  }
  if (mark.state !== "out_of_date") return null;
  return (
    <span className="badge wait" data-testid="out-of-date" title={`This ${what} has not been checked recently.`}>
      May be out of date{mark.checkedAt ? ` · checked ${formatDate(mark.checkedAt)}` : ""}
    </span>
  );
}
