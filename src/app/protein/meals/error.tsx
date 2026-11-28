"use client";
import Link from "next/link";
import { useEffect } from "react";

/** The meal list failed to load: a plain sentence, a retry, and ways back to the meal lists. */
export default function MealsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("page_error", error.name, error.digest ?? "");
  }, [error]);
  return (
    <main id="main" className="content narrow" data-testid="error-page">
      <h1 className="title">We couldn&rsquo;t load the meals</h1>
      <p>Your saves, lists and reviews are safe. Please try again in a moment.</p>
      {error.digest && <p className="muted">Reference: {error.digest}</p>}
      <div className="row">
        <button className="btn primary" type="button" onClick={() => reset()}>
          Try again
        </button>
        <Link className="btn" href="/protein/meals">
          All meals
        </Link>
        <Link className="btn" href="/places/menus">
          Restaurants with menus
        </Link>
      </div>
    </main>
  );
}
