import Link from "next/link";
import { AppShell } from "@/components/app-shell";

export const metadata = { title: "Account deleted" };

export default function Page() {
  return (
    <AppShell active="account" narrow>
      <h1 className="title">Your account is deleted</h1>
      <p role="status" data-testid="account-deleted">
        Your diary, goals, foods, cooking history, plans, profile, reviews, ranking and lists have been removed. You are signed out on this browser.
      </p>
      <p className="muted">You can keep browsing without an account, or make a new one at any time. A new account starts empty.</p>
      <p>
        <Link className="btn primary" href="/discover">
          Go to Discover
        </Link>
      </p>
    </AppShell>
  );
}
