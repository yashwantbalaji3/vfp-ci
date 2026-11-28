import { Suspense } from "react";
import Link from "next/link";
import { AppShell, Loading } from "@/components/app-shell";
import { startChangeAction } from "@/app/editor/actions";
import { ChangeList, PracticeNote, StaffDenied, StaffNav } from "@/components/editor/bits";
import { Flash, SignInPrompt } from "@/components/social/bits";
import { targetHref } from "@/contracts/social";
import { formatAmount, formatDate, titleCase } from "@/lib/format";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { getDesk, getNutritionChecks, getStaffAlerts } from "@/server/editor";

export const metadata = { title: "Editors' desk", robots: { index: false, follow: false } };

async function Desk({ searchParams }: { searchParams: Promise<RawParams> }) {
  const sp = await searchParams;
  const member = await getCurrentMember();
  if (!member) {
    return (
      <SignInPrompt next="/editor">
        <p>Sign in to continue.</p>
      </SignInPrompt>
    );
  }
  const alerts = await getStaffAlerts();
  if (!alerts?.isEditor) return <StaffDenied what="catalog editors" />;
  const [desk, nutritionChecks] = await Promise.all([getDesk(), getNutritionChecks()]);
  const toCheck = desk.awaitingCheck.filter((c) => !c.authorIsMe);
  const mineWaiting = desk.awaitingCheck.filter((c) => c.authorIsMe);
  return (
    <>
      <StaffNav alerts={alerts} here="/editor" />
      <Flash sp={sp} />
      {desk.practiceMode && <PracticeNote />}
      <p className="s14 muted">
        Nothing an editor enters is public until a second person has checked it against its source. The person who checks is never the person who entered it.
      </p>

      <h2 className="h-sec">Waiting for a second person ({toCheck.length})</h2>
      {!desk.canPublish && toCheck.length > 0 && <p className="s14 muted">These need someone with the publisher role.</p>}
      <ChangeList changes={toCheck} empty="Nothing is waiting to be checked." testid="desk-to-check" />

      <h2 className="h-sec">Your drafts ({desk.myDrafts.length})</h2>
      <ChangeList changes={desk.myDrafts} empty="You have no drafts." testid="desk-drafts" />
      {mineWaiting.length > 0 && (
        <>
          <h2 className="h-sec">Yours, waiting for someone else ({mineWaiting.length})</h2>
          <ChangeList changes={mineWaiting} empty="" testid="desk-mine-waiting" />
        </>
      )}

      <h2 className="h-sec">Accepted corrections not yet acted on ({desk.acceptedCorrections.length})</h2>
      {desk.acceptedCorrections.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        <ul className="feed" data-testid="desk-corrections">
          {desk.acceptedCorrections.map((c) => (
            <li className="post" key={c.correctionId}>
              <p className="kind" style={{ margin: 0 }}>
                {titleCase(c.field)}
                {c.decidedAt ? ` · accepted ${formatDate(c.decidedAt)}` : ""}
              </p>
              <p className="about" style={{ marginTop: 2 }}>{c.target ? <Link href={targetHref(c.target)}>{c.target.name}</Link> : "This item is no longer public"}</p>
              <p className="text">{c.proposedValue}</p>
              {c.openChangeId ? (
                <p className="s14" style={{ margin: "8px 0 0" }}>
                  <Link className="link" href={`/editor/changes/${c.openChangeId}`}>
                    Open the change in progress
                  </Link>
                </p>
              ) : (
                c.target && (
                  <form action={startChangeAction} style={{ marginTop: 10 }}>
                    <input type="hidden" name="return" value="/editor" />
                    <input type="hidden" name="correctionId" value={c.correctionId} />
                    {c.foodItemId ? <input type="hidden" name="foodItemId" value={c.foodItemId} /> : <input type="hidden" name="venueId" value={c.venueId ?? ""} />}
                    <button className="btn small" type="submit">
                      Start a change from this
                    </button>
                  </form>
                )
              )}
            </li>
          ))}
        </ul>
      )}

      <h2 className="h-sec">Marked as needing review ({desk.flags.length})</h2>
      {desk.flags.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        <ul className="feed" data-testid="desk-flags">
          {desk.flags.map((f) => (
            <li className="post" key={f.flagId}>
              <p className="about" style={{ margin: 0 }}>
                <Link href={`/foods/${f.foodItemId}`}>{f.name}</Link>
              </p>
              <p className="text">{f.reason}</p>
              <p className="s13 muted" style={{ margin: "6px 0 0" }}>
                Marked {formatDate(f.raisedAt)}
                {f.raisedBy ? ` by ${f.raisedBy}` : ""}. Out of every dietary filter until a checked version replaces it.
              </p>
              {f.openChangeId ? (
                <p className="s14" style={{ margin: "8px 0 0" }}>
                  <Link className="link" href={`/editor/changes/${f.openChangeId}`}>
                    Open the change in progress
                  </Link>
                </p>
              ) : (
                <form action={startChangeAction} style={{ marginTop: 10 }}>
                  <input type="hidden" name="return" value="/editor" />
                  <input type="hidden" name="foodItemId" value={f.foodItemId} />
                  <button className="btn small" type="submit">
                    Start a checked version
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}

      <h2 className="h-sec">Protein figures that disagree with our calculation ({nutritionChecks.length})</h2>
      {nutritionChecks.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        <ul className="feed" data-testid="desk-nutrition-checks">
          {nutritionChecks.map((n) => (
            <li className="post" key={n.checkId}>
              <p className="about" style={{ margin: 0 }}>
                <Link href={`/foods/${n.foodItemId}`}>{n.name}</Link>
              </p>
              <p className="text">
                The restaurant publishes {formatAmount(n.published)} g protein; our calculation from the ingredients gives{" "}
                {n.calculated === null ? "no figure" : `${formatAmount(n.calculated)} g`}
                {n.relativeGap === null ? "" : `, ${Math.round(n.relativeGap * 100)}% apart`} (more than {Math.round(n.threshold * 100)}%).
              </p>
              <p className="s13 muted" style={{ margin: "6px 0 0" }}>
                Checked {formatDate(n.checkedAt)}. The restaurant&rsquo;s figure is still the one shown; nothing is averaged. Someone other than the person who ran the check decides what is right.
              </p>
            </li>
          ))}
        </ul>
      )}

      <h2 className="h-sec">Due for a fresh check ({desk.outOfDate.length})</h2>
      {desk.outOfDate.length === 0 ? (
        <p className="muted" data-testid="desk-fresh">
          Everything has been checked recently.
        </p>
      ) : (
        <ul className="s14" data-testid="desk-out-of-date" style={{ paddingLeft: 20 }}>
          {desk.outOfDate.map((o) => (
            <li key={o.foodItemId ?? o.venueId}>
              <Link className="link" href={o.venueId ? `/venues/${o.venueId}` : `/foods/${o.foodItemId}`}>
                {o.name}
              </Link>{" "}
              · {o.kind === "venue" ? "place" : o.kind} · {o.state === "out_of_date" ? "out of date" : "due"}
              {o.checkedAt ? ` · last checked ${formatDate(o.checkedAt)}` : " · never checked"}
            </li>
          ))}
        </ul>
      )}

      <h2 className="h-sec">Recently decided</h2>
      <ChangeList changes={desk.recent} empty="Nothing decided yet." testid="desk-recent" />
    </>
  );
}

export default function EditorDeskPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  return (
    <AppShell active="none" narrow>
      <h1 className="title">Editors&rsquo; desk</h1>
      <Suspense fallback={<Loading />}>
        <Desk searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}
