"use client";
import "./globals.css";

/**
 * Last-resort error screen, used only when the outer page frame itself fails. It must
 * bring its own <html> and <body>. Same rule as error.tsx: no technical detail.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body>
        <main id="main" className="content narrow" data-testid="error-page">
          <h1 className="title">Something went wrong on our side</h1>
          <p>Please try again in a moment.</p>
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
      </body>
    </html>
  );
}
