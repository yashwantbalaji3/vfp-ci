import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell, Loading } from "@/components/app-shell";
import { LEGAL_TEXT_APPROVED, LEGAL_VERSION } from "@/content/legal";
import { safeReturnPath } from "@/lib/format";
import type { RawParams } from "@/lib/search-params";
import { deleteAccountAction } from "@/app/social/actions";
import { getCurrentMember } from "@/server/auth/session";

export const metadata = { title: "Before you start" };

const MESSAGES: Record<string, string> = {
  both: "Please tick both boxes to continue.",
  changed: "The Terms or Privacy notice changed while this page was open. Please read and confirm again.",
  failed: "That didn't save. Please try again.",
};

async function Welcome({ searchParams }: { searchParams: Promise<RawParams> }) {
  const sp = await searchParams;
  const next = safeReturnPath(typeof sp.next === "string" ? sp.next : null, "/today");
  const member = await getCurrentMember();
  if (!member) redirect(`/login?next=${encodeURIComponent(next)}`);
  const message = typeof sp.e === "string" ? MESSAGES[sp.e] : undefined;
  if (sp.under === "1") {
    return (
      <div className="panel stack" data-testid="welcome-under-18">
        <p style={{ marginTop: 0 }}>This test is open only to adults (18 or older), so this account can&apos;t be used.</p>
        <p>You can delete it now. Nothing you have added is kept.</p>
        <form action={deleteAccountAction}>
          <input type="hidden" name="confirm" value="DELETE" />
          <button className="btn danger" type="submit">
            Delete this account
          </button>
        </form>
        <Link className="link" href={`/welcome?next=${encodeURIComponent(next)}`}>
          Go back
        </Link>
      </div>
    );
  }
  return (
    <form action="/welcome/confirm" method="post" className="panel stack" data-testid="welcome-form">
      {message && (
        <p role="alert" className="s14" data-testid="welcome-error" style={{ margin: 0 }}>
          {message}
        </p>
      )}
      <p style={{ marginTop: 0 }}>
        This is a small, invite-only test for adults. Before you use it, please confirm two things.
        {!LEGAL_TEXT_APPROVED && " The Terms and Privacy notice are still drafts and may change; if they do, you'll be asked again."}
      </p>
      <input type="hidden" name="next" value={next} />
      <input type="hidden" name="version" value={LEGAL_VERSION} />
      <label className="check">
        <input type="checkbox" name="adult" value="yes" required /> I am 18 or older.
      </label>
      <label className="check">
        <input type="checkbox" name="agree" value="yes" required /> I have read and agree to the{" "}
        <Link className="link" href="/terms" target="_blank">
          Terms
        </Link>{" "}
        and the{" "}
        <Link className="link" href="/privacy" target="_blank">
          Privacy notice
        </Link>
        .
      </label>
      <button className="btn primary" type="submit">
        Continue
      </button>
      <p className="s13 muted" style={{ margin: 0 }}>
        Signed in as {member.email}.{" "}
        <Link className="link" href={`/welcome?next=${encodeURIComponent(next)}&under=1`}>
          I&apos;m under 18
        </Link>
      </p>
    </form>
  );
}

export default function Page({ searchParams }: { searchParams: Promise<RawParams> }) {
  return (
    <AppShell active="none" narrow>
      <h1 className="title">Before you start</h1>
      <Suspense fallback={<Loading />}>
        <Welcome searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}
