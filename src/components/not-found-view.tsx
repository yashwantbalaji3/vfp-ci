import Link from "next/link";
import { AppShell } from "./app-shell";

/** One "not found" screen, used by the framework's not-found boundary including the 404 the request proxy triggers for a missing dish or place. */
export function NotFoundView() {
  return (
    <AppShell active="none" narrow>
      <h1 className="title">We couldn&rsquo;t find that</h1>
      <p>It may have been removed, or the address may be wrong.</p>
      <Link className="btn primary" href="/discover">
        Back to Discover
      </Link>
    </AppShell>
  );
}
