"use client";
import { useEffect } from "react";

/**
 * The app's own error screen (R1, audit A3-2). Shown when a page hits a fault on the
 * server or in the browser. It never shows the technical detail: the visitor gets a
 * plain sentence, a way to retry and a way out. The reference is a short code the
 * framework generates, safe to quote when reporting a problem.
 */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Name only: an error message can contain what the person typed.
    console.error("page_error", error.name, error.digest ?? "");
  }, [error]);
  return (
    <main id="main" className="content narrow" data-testid="error-page">
      <h1 className="title">Something went wrong on our side</h1>
      <p>Nothing you entered was lost from your account. Please try again in a moment.</p>
      {error.digest && <p className="muted">Reference: {error.digest}</p>}
      <div className="row">
        <button className="btn primary" type="button" onClick={() => reset()}>
          Try again
        </button>
        <a className="btn" href="/discover">
          Back to Discover
        </a>
      </div>
    </main>
  );
}
