import type { LimitOutcome } from "@/server/rate-limit";

/** Shown in place of results when one visitor address has asked for too many pages in a minute. Nothing is searched. */
export function TooManyRequests() {
  return (
    <div className="panel" role="alert" data-testid="too-many-requests">
      <h2 className="h-sec" style={{ marginTop: 0 }}>
        Too many requests
      </h2>
      <p style={{ marginBottom: 0 }}>Please wait a minute and try again. Nothing is wrong with your account.</p>
    </div>
  );
}

/**
 * Shown when the request counter itself could not be checked (for example the database is not
 * reachable, or it does not recognise this server). The page still refuses to search (fail closed),
 * but it no longer pretends the visitor asked too often.
 */
export function LimitUnavailable() {
  return (
    <div className="panel" role="alert" data-testid="limit-unavailable">
      <h2 className="h-sec" style={{ marginTop: 0 }}>
        This page is temporarily unavailable
      </h2>
      <p style={{ marginBottom: 0 }}>We couldn&rsquo;t check our request safeguard, so nothing was searched. Please try again shortly.</p>
    </div>
  );
}

/** What a searching page shows instead of its results: nothing when the request is within the limit. */
export function limitNotice(outcome: LimitOutcome) {
  if (outcome === "ok") return null;
  return outcome === "limited" ? <TooManyRequests /> : <LimitUnavailable />;
}
