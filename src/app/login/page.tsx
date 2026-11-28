import Link from "next/link";
import { Suspense } from "react";
import { AppShell, Loading } from "@/components/app-shell";
import { safeReturnPath } from "@/lib/format";
import type { RawParams } from "@/lib/search-params";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in" };

async function Form({ searchParams }: { searchParams: Promise<RawParams> }) {
  const sp = await searchParams;
  const raw = Array.isArray(sp.next) ? sp.next[0] : sp.next;
  const next = raw ? safeReturnPath(raw, "/account") : undefined;
  return (
    <>
      {sp.error && (
        <p className="callout" role="alert">
          That sign-in link didn&rsquo;t work. It may have expired. Ask for a new one below.
        </p>
      )}
      {next && next !== "/account" && <p className="muted">After signing in you&rsquo;ll go back to the page you were on.</p>}
      <LoginForm next={next} />
    </>
  );
}

export default function LoginPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  return (
    <AppShell active="account" narrow>
      <h1 className="title">Sign in</h1>
      <Suspense fallback={<Loading />}>
        <Form searchParams={searchParams} />
      </Suspense>
      <p className="s13 muted" style={{ marginTop: 24 }} data-testid="legal-links">
        <Link href="/privacy">Privacy</Link> · <Link href="/terms">Terms</Link>
      </p>
    </AppShell>
  );
}
