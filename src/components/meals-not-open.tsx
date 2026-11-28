import Link from "next/link";

/**
 * What a signed-in person sees on a restaurant-meal page when restaurant meals are not open to their account
 * (the member beta is off, or they are not one of its testers). Replaces a "not found" page, which read as a
 * broken link. It says the same thing whether or not any meals exist, so it reveals nothing about the private test.
 */
export function MealsNotOpen() {
  return (
    <div className="empty" data-testid="meals-not-open">
      <p>
        <strong>Restaurant meals are not open to your account yet.</strong>
      </p>
      <p className="s14">
        A restaurant listing tells you a place exists. A restaurant with reviewed meals also has its dishes, what the
        restaurant says about diet, and protein figures, each checked against the restaurant&rsquo;s own page by a person.
        Meals open in small groups once that check is done.
      </p>
      <p className="row">
        <Link className="btn primary" href="/protein">
          Find high-protein recipes
        </Link>
        <Link className="btn" href="/cook">
          Cook at home
        </Link>
      </p>
    </div>
  );
}
