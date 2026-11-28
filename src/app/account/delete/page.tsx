import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell, Loading } from "@/components/app-shell";
import { deleteAccountAction } from "@/app/social/actions";
import { Flash } from "@/components/social/bits";
import { Icon } from "@/components/icons";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";

export const metadata = { title: "Delete your account" };

async function DeleteForm({ searchParams }: { searchParams: Promise<RawParams> }) {
  const sp = await searchParams;
  const member = await getCurrentMember();
  if (!member) redirect("/login?next=/account/delete");
  const needsFreshSignIn = sp.e === "REAUTH_REQUIRED";
  return (
    <>
      <Flash sp={sp} />
      {needsFreshSignIn && (
        <form action="/auth/signout" method="post" style={{ margin: "12px 0" }}>
          <button className="btn" type="submit">
            Sign out now
          </button>
          <span className="s13 muted" style={{ display: "block", marginTop: 4 }}>Then sign in again and come back to Account, Delete your account.</span>
        </form>
      )}
      <div className="panel">
        <p style={{ marginTop: 0 }}>
          Signed in as <strong>{member.email}</strong>
        </p>
        <h2 className="h-sec" style={{ marginTop: 0 }}>
          What is deleted, for good
        </h2>
        <ul>
          <li>Your food diary, daily totals and goals</li>
          <li>Foods you created, saved items, your dietary filter</li>
          <li>Your cooking history and week plan</li>
          <li>Your profile, reviews, ranking and lists, and who you follow or are friends with</li>
        </ul>
        <h2 className="h-sec">What is kept</h2>
        <ul>
          <li>Public restaurant, dish and recipe pages. Deleting your account never changes them.</li>
          <li>A one-way code that cannot be turned back into your account, so that if an old backup is ever restored your data is removed from it again. It is kept for 30 days.</li>
          <li>One line in our audit log saying that an account was deleted, without your identity.</li>
        </ul>
        <p className="s14 muted">Ratings you gave stop counting as soon as the account is deleted. This cannot be undone.</p>
        <p>
          <Link className="link" href="/diary/goals">
            Download a copy of your data first
          </Link>
        </p>
      </div>
      <form action={deleteAccountAction} className="panel stack" data-testid="delete-account-form">
        <div>
          <label htmlFor="del-confirm">Type DELETE to confirm</label>
          <input id="del-confirm" type="text" name="confirm" autoComplete="off" autoCapitalize="characters" required aria-describedby="del-hint" />
          <p className="s13 muted" id="del-hint" style={{ margin: "4px 0 0" }}>
            Capital letters. For your safety this works only within 10 minutes of signing in.
          </p>
        </div>
        <button className="btn danger" type="submit">
          Delete my account and all my data
        </button>
      </form>
    </>
  );
}

export default function Page({ searchParams }: { searchParams: Promise<RawParams> }) {
  return (
    <AppShell active="account" narrow>
      <Link className="link-btn" href="/account">
        <Icon name="back" />
        Account
      </Link>
      <h1 className="title">Delete your account</h1>
      <Suspense fallback={<Loading />}>
        <DeleteForm searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}
