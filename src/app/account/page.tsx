import { Suspense } from "react";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { getCurrentMember } from "@/server/auth/session";
import { getStaffAlerts } from "@/server/editor";
import { DietWelcome } from "@/components/diet-welcome";
import { readSavedDiet } from "@/server/catalog/diet";
import { describeDietChoice, hasDietChoice } from "@/domain/dietary/labels";

/** Shown only to people who hold a staff role. */
async function StaffLinks() {
  const alerts = await getStaffAlerts().catch(() => null);
  if (!alerts) return null;
  const waiting = (alerts.awaitingCheck ?? 0) + (alerts.openCorrections ?? 0) + (alerts.pendingPosts ?? 0) + (alerts.openReports ?? 0);
  return (
    <section className="panel acct-sec" data-testid="staff-links" aria-labelledby="acct-staff">
      <h2 id="acct-staff" className="s16">
        Staff
      </h2>
      {waiting > 0 && (
        <p className="s14" style={{ margin: "4px 0 0" }} data-testid="staff-waiting">
          {waiting} {waiting === 1 ? "item is" : "items are"} waiting for staff.
        </p>
      )}
      <p className="row" style={{ margin: "8px 0 0" }}>
        {alerts.isModerator && (
          <Link className="link" href="/moderation">
            Moderation
          </Link>
        )}
        {alerts.isEditor && (
          <Link className="link" href="/moderation/corrections">
            Corrections
          </Link>
        )}
        {alerts.isEditor && (
          <Link className="link" href="/editor">
            Editors&rsquo; desk
          </Link>
        )}
      </p>
    </section>
  );
}

async function AccountDetails() {
  const member = await getCurrentMember();
  if (!member) {
    return (
      <div className="panel">
        <p>You&rsquo;re not signed in.</p>
        <Link className="button" href="/login">
          Sign in
        </Link>
      </div>
    );
  }
  const saved = await readSavedDiet();
  return (
    <>
      <DietWelcome returnTo="/account" />
      <div className="acct">
        {saved !== null && (
          <section className="panel acct-sec" aria-labelledby="acct-diet" data-testid="account-diet">
            <h2 id="acct-diet" className="s16">
              Your diet
            </h2>
            <p className="s14" style={{ margin: "2px 0 8px" }}>
              {describeDietChoice(saved)}. {hasDietChoice(saved) ? "Searches show only food the restaurant or recipe states fits." : "No filter, so you see everything."}
            </p>
            <Link className="btn" href="/diet?return=%2Faccount">
              Change your diet
            </Link>
          </section>
        )}
        <section className="panel acct-sec" aria-labelledby="acct-private">
          <h2 id="acct-private" className="s16">
            Privacy and your data
          </h2>
          <p className="s14 muted" style={{ margin: "2px 0 6px" }}>
            Your diary, goals and custom foods are private to you. Friends and followers can never see them.
          </p>
          <ul className="acct-links">
            <li>
              <Link className="link" href="/diary/goals">
                Goals and a download of your data
              </Link>
            </li>
            <li>
              <Link className="link" href="/friends/profile">
                Your public profile and what it shows
              </Link>
            </li>
          </ul>
        </section>
        <section className="panel acct-sec" aria-labelledby="acct-yours">
          <h2 id="acct-yours" className="s16">
            Things you keep
          </h2>
          <ul className="acct-links">
            <li>
              <Link className="link" href="/saved">
                Saved places and meals
              </Link>
            </li>
            <li>
              <Link className="link" href="/friends">
                Friends, lists and reviews
              </Link>
            </li>
            <li>
              <Link className="link" href="/account/corrections">
                Problems you have reported
              </Link>
            </li>
            <li>
              <Link className="link" href="/feedback" data-testid="feedback-link">
                Tell us how the test went
              </Link>
            </li>
          </ul>
        </section>
        <Suspense fallback={null}>
          <StaffLinks />
        </Suspense>
        <section className="panel acct-sec" aria-labelledby="acct-signin">
          <h2 id="acct-signin" className="s16">
            Sign-in
          </h2>
          <p className="s14" data-testid="signed-in-as" style={{ margin: "2px 0 8px", overflowWrap: "anywhere" }}>
            Signed in as <strong>{member.email}</strong>
          </p>
          <form action="/auth/signout" method="post">
            <button className="button" type="submit">
              Sign out
            </button>
          </form>
          <p className="s14" style={{ margin: "16px 0 0" }}>
            <Link className="link" href="/account/delete" data-testid="delete-account-link">
              Delete your account
            </Link>
          </p>
        </section>
      </div>
    </>
  );
}

export default function AccountPage() {
  return (
    <AppShell active="account" narrow>
      <h1 className="title">Your account</h1>
      <Suspense fallback={<p className="muted">Loading your account…</p>}>
        <AccountDetails />
      </Suspense>
      <p className="s13 muted" style={{ marginTop: 24 }} data-testid="legal-links">
        <Link href="/privacy">Privacy</Link> · <Link href="/terms">Terms</Link>
      </p>
    </AppShell>
  );
}
