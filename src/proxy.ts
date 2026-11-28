import { createServerClient } from "@supabase/ssr";
import { withSecureFlag } from "@/lib/supabase/cookie-options";
import { NextResponse, type NextRequest } from "next/server";
import { FLAGS } from "@/config/flags";
import { ELIGIBILITY_COOKIE, eligibilityCookieValue, isConfirmed, needsNoConfirmation, readEligibility } from "@/server/eligibility";

/**
 * Refreshes the Supabase session cookie on each request (Next.js 16 "proxy",
 * formerly middleware). This is not an authorization check: every page, route
 * and database function verifies access itself.
 */
const DETAIL_PATH = /^\/(foods|dishes|venues)\/([^/]+)\/?$/;
/** A recipe page, /cook/<id>. The plan and cooking-session pages under /cook are not catalog items. */
const RECIPE_PATH = /^\/(cook)\/((?!plan\/?$)[^/]+)\/?$/;
/** A member profile, /u/<handle>, or a shared list, /lists/<id>. */
const SOCIAL_PATH = /^\/(u|lists)\/([^/]+)\/?$/;
/** A real place page, /places/<slug>. The review area, the founder-only menu list and the suggestions queue under /places are not places. */
const PLACE_PATH = /^\/places\/((?!(?:review|menus|contributions)\/?$)[a-z0-9-]{2,120})\/?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, withSecureFlag(options)));
        },
      },
    },
  );
  const { data: session } = await supabase.auth.getClaims();
  const path = request.nextUrl.pathname;

  // The front door (docs/68, L1): a signed-in member opens on Today, a visitor on Discover, which works
  // without an account (R-001). Done here because a page that only redirects cannot be prerendered.
  if (path === "/") {
    const home = NextResponse.redirect(new URL(session?.claims ? "/today" : "/discover", request.url), 307);
    for (const c of response.cookies.getAll()) home.cookies.set(c);
    home.headers.set("Cache-Control", "private, no-store");
    return home;
  }

  // Adults-only beta (migration 20261126000200): a signed-in member who has not confirmed they are 18 or older and
  // agreed to the current Terms and Privacy version is sent to "Before you start". A cookie remembers the answer for
  // this browser, so the check costs one database call per browser and policy version, not one per page. The
  // database functions still decide every read and write; this decides only which page a member sees first.
  const sub = (session?.claims as { sub?: string } | undefined)?.sub;
  if (sub && !needsNoConfirmation(path) && request.cookies.get(ELIGIBILITY_COOKIE)?.value !== eligibilityCookieValue(sub)) {
    const eligibility = await readEligibility(supabase);
    if (eligibility && !isConfirmed(eligibility)) {
      const to = new URL("/welcome", request.url);
      to.searchParams.set("next", path + request.nextUrl.search);
      const welcome = NextResponse.redirect(to, 307);
      for (const c of response.cookies.getAll()) welcome.cookies.set(c);
      welcome.headers.set("Cache-Control", "private, no-store");
      return welcome;
    }
    if (eligibility) {
      response.cookies.set(ELIGIBILITY_COOKIE, eligibilityCookieValue(sub), withSecureFlag({ httpOnly: true, sameSite: "lax" as const, path: "/", maxAge: 60 * 60 * 24 * 365 }));
    }
  }

  // A dish or place that does not exist must answer with a real 404. Detail pages stream
  // their shell first, which would fix the status at 200, so existence is checked here.
  const missingPage = () => {
    // Rewriting to an address with no route makes the framework serve its not-found page with status 404.
    const missing = NextResponse.rewrite(new URL("/_missing/item", request.url));
    response.cookies.getAll().forEach((cookie) => missing.cookies.set(cookie));
    missing.headers.set("Cache-Control", "private, no-store");
    return missing;
  };

  // The same for a profile or list that does not exist or that this viewer may not see: one
  // answer for all of those, so nothing can be learned from the difference. A signed-out
  // visitor is only asked the question when public social reading is on; otherwise the page
  // shows its sign-in prompt.
  const social = path.match(SOCIAL_PATH);
  if (social && (session?.claims || FLAGS.socialPublicEnabled)) {
    let ref = social[2];
    try {
      ref = decodeURIComponent(ref);
    } catch {
      return missingPage();
    }
    const { data, error } = await supabase.rpc("social_page_exists", {
      p_kind: social[1] === "u" ? "profile" : "list",
      p_ref: ref.replace(/^@/, "").toLowerCase(),
      p_include_demo: FLAGS.allowDemoContent,
    });
    if (!error && data !== true) return missingPage();
  }

  // A real place this signed-in viewer may not see answers with the same 404 as one that does not
  // exist. A signed-out visitor gets the page's sign-in prompt instead, which names no place.
  const place = path.match(PLACE_PATH);
  if (place && session?.claims) {
    const { data, error } = await supabase.rpc("place_detail", { p_slug: place[1], p_preview: FLAGS.realCatalogPreview });
    if (!error && data == null) return missingPage();
  }

  const detail = path.match(DETAIL_PATH) ?? path.match(RECIPE_PATH);
  if (detail) {
    const kind = detail[1] === "venues" ? "venue" : "food";
    let exists = UUID.test(detail[2]);
    if (exists) {
      const { data, error } = await supabase.rpc("catalog_item_exists", {
        p_kind: kind,
        p_id: detail[2],
        p_include_demo: process.env.ALLOW_DEMO_CONTENT === "true",
      });
      // If the check itself fails, let the page load and report the problem in its own words.
      exists = error ? true : data === true;
      // A real place's app record (docs/49) is not a catalog venue: older links in feeds, lists and rankings, and the
      // return from writing a review, go to its place page with their outcome. Only a place the viewer may see has one.
      if (!exists && kind === "venue") {
        const slug = await supabase.rpc("place_slug_for_venue", { p_venue: detail[2] });
        if (!slug.error && typeof slug.data === "string") {
          const to = new URL(`/places/${slug.data}`, request.url);
          for (const k of ["m", "e", "saved"]) {
            const v = request.nextUrl.searchParams.get(k);
            if (v && /^[A-Za-z_]{1,40}$/.test(v)) to.searchParams.set(k, v);
          }
          const moved = NextResponse.redirect(to, 303);
          for (const c of response.cookies.getAll()) moved.cookies.set(c);
          moved.headers.set("Cache-Control", "private, no-store");
          return moved;
        }
      }
    }
    if (!exists) return missingPage();
  }

  // A response that refreshes a session cookie must never be shared from a cache.
  if (response.headers.get("set-cookie")) {
    response.headers.set("Cache-Control", "private, no-store");
  }
  return response;
}

export const config = {
  // The street-map file and its fonts and icons are public map data: no session work is needed for them.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|map-data/|maps/|.*\\.(?:svg|png|jpg|jpeg|webp|pbf)$).*)"],
};
