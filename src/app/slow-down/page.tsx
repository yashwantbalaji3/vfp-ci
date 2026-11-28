import Link from "next/link";
import { AppShell } from "@/components/app-shell";

export const metadata = { title: "Please wait a moment" };

/** Where a form press lands when one member has pressed too many in a minute. Nothing was saved or changed by the refused press. */
export default function SlowDownPage() {
  return (
    <AppShell active="none" narrow>
      <h1 className="title">Please wait a moment</h1>
      <p data-testid="slow-down">
        That was a lot of changes in a short time, so the last one was not saved. Nothing is wrong with your account. Please wait a minute and try again.
      </p>
      <Link className="btn primary" href="/diary">
        Back to your diary
      </Link>
    </AppShell>
  );
}
