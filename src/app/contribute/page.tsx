import { Suspense } from "react";
import Link from "next/link";
import { AppShell, Loading } from "@/components/app-shell";
import { SignInPrompt } from "@/components/social/bits";
import { BRANCH_FIELDS, DIET_CLAIMS, FIELDS, KINDS, SOURCES, STATUS_WORDS, kindLabel, type Kind } from "@/contracts/community";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { getPlaceDetail } from "@/server/catalog/places";
import { getPreviewForSlug } from "@/server/catalog/menu-preview";
import { communityOpen, getMySuggestions } from "@/server/member/community";
import { submitSuggestionAction, withdrawSuggestionAction } from "./actions";

export const metadata = { title: "Suggest a change", robots: { index: false, follow: false } };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const SLUG = /^[a-z0-9-]{1,120}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OK: Record<string, string> = {
  sent: "Thank you. Your suggestion is saved. We check every suggestion at its source before anything on a restaurant's page changes.",
  withdrawn: "Withdrawn.",
};
const ERR: Record<string, string> = {
  TERMS_NOT_AGREED: "Please tick the box to say this is your own observation or a link.",
  INVALID_SUGGESTION: "Please fill in the required fields (marked) and keep text short.",
  TOO_MANY: "That's a lot of suggestions for one day. Please try again tomorrow.",
  ALREADY_SENT: "You've already sent this suggestion, and it is still open. It is listed below.",
  NOT_OPEN: "Suggestions aren't open yet.",
  PLACE_NEEDED: "Please start from the restaurant's page so we know which one you mean.",
  DISH_NOT_AT_PLACE: "That dish isn't on this restaurant's menu.",
};

async function Contribute({ searchParams }: { searchParams: Promise<RawParams> }) {
  const sp = await searchParams;
  const member = await getCurrentMember();
  if (!member) {
    return (
      <SignInPrompt next="/contribute">
        <p>Sign in to suggest a missing dish, a correction or where a restaurant publishes its menu.</p>
      </SignInPrompt>
    );
  }
  if (!(await communityOpen())) {
    return (
      <section className="empty" data-testid="contribute-closed">
        <h2>Suggestions aren&rsquo;t open yet</h2>
        <p>We&rsquo;re testing this with a small group first. Thanks for wanting to help.</p>
        <p>
          <Link className="btn" href="/discover">
            Back to Discover
          </Link>
        </p>
      </section>
    );
  }
  const slug = one(sp.place);
  const place = slug && SLUG.test(slug) ? await getPlaceDetail(slug).catch(() => null) : null;
  const dishId = one(sp.dish);
  const preview = place && dishId && UUID.test(dishId) ? await getPreviewForSlug(place.slug).catch(() => null) : null;
  const dish = preview?.meals.find((m) => m.dishId === dishId) ?? null;
  const kindParam = one(sp.kind);
  const kind = KINDS.find((k) => k.v === kindParam)?.v as Kind | undefined;
  const ok = OK[one(sp.m) ?? ""];
  const errCode = one(sp.e);
  const err = errCode ? (ERR[errCode] ?? "That didn't work. Nothing was saved.") : null;
  const mine = await getMySuggestions().catch(() => []);
  const ctx = `${place ? `&place=${place.slug}` : ""}${dish ? `&dish=${dish.dishId}` : ""}`;

  return (
    <>
      {ok && (
        <p className="callout ok" role="status" data-testid="contribute-ok">
          {ok}
        </p>
      )}
      {err && (
        <p className="callout stop" role="alert" data-testid="contribute-error">
          {err}
        </p>
      )}
      {place && (
        <p className="s14" data-testid="contribute-place">
          About <Link href={`/places/${place.slug}`}>{place.name}</Link>, {place.street}
          {dish ? (
            <>
              {" "}
              · <strong>{dish.label}</strong>
            </>
          ) : null}
        </p>
      )}
      {!kind ? (
        <section aria-labelledby="kinds-h">
          <h2 className="h-sec" id="kinds-h">
            What would you like to tell us?
          </h2>
          <ul className="choice-tiles" data-testid="contribute-kinds">
            {KINDS.filter((k) => (place ? k.needsPlace : !k.needsPlace) || k.v === "missing_restaurant").map((k) => (
              <li key={k.v}>
                <Link href={`/contribute?kind=${k.v}${ctx}`} data-testid={`contribute-kind-${k.v}`}>
                  {k.label}
                </Link>
              </li>
            ))}
          </ul>
          {!place && (
            <p className="s14 muted">
              To suggest a dish, a correction or a price, open the restaurant&rsquo;s page and choose &ldquo;Suggest a change&rdquo;, so we know which
              branch you mean.
            </p>
          )}
        </section>
      ) : KINDS.find((k) => k.v === kind)!.needsPlace && !place ? (
        <p className="callout" data-testid="contribute-need-place">
          Please start from the restaurant&rsquo;s page so we know which one you mean. <Link href="/places/menus">Find a restaurant</Link>
        </p>
      ) : (
        <SuggestionForm kind={kind} listing={place?.id ?? null} slug={place?.slug ?? null} dish={dish ? { id: dish.dishId, label: dish.label } : null} />
      )}

      <section aria-labelledby="mine-h" data-testid="contribute-mine">
        <h2 className="h-sec" id="mine-h">
          Your suggestions
        </h2>
        {mine.length === 0 ? (
          <p className="muted s14">None yet.</p>
        ) : (
          <ul className="list-plain">
            {mine.map((s) => (
              <li key={s.id} className="panel" data-testid="contribute-row" data-status={s.status}>
                <strong>{kindLabel(s.kind)}</strong>
                {s.details.dish || s.details.name ? `: ${s.details.dish ?? s.details.name}` : ""}
                <div className="s14 muted">{STATUS_WORDS[s.status]}</div>
                {s.reviewNote && <div className="s14">Note from the reviewer: {s.reviewNote}</div>}
                {(s.status === "submitted" || s.status === "needs_more") && (
                  <form action={withdrawSuggestionAction} style={{ marginTop: 6 }}>
                    <input type="hidden" name="id" value={s.id} />
                    <button className="link-btn" type="submit" data-testid="contribute-withdraw">
                      Withdraw
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="s13 muted">
          Only the reviewer sees your suggestions, under a contributor code rather than your name or email. They&rsquo;re deleted with your account.
        </p>
      </section>
    </>
  );
}

function Source({ required = true }: { required?: boolean }) {
  return (
    <>
      <label htmlFor="source">Where did you see this?{required ? " (required)" : ""}</label>
      <select id="source" name="source" required={required} defaultValue="">
        <option value="" disabled>
          Choose one
        </option>
        {SOURCES.map((s) => (
          <option key={s.v} value={s.v}>
            {s.label}
          </option>
        ))}
      </select>
    </>
  );
}
const Url = ({ required = false, label = "Link to it, if it's online" }: { required?: boolean; label?: string }) => (
  <>
    <label htmlFor="url">
      {label}
      {required ? " (required)" : ""}
    </label>
    <input id="url" name="url" type="url" inputMode="url" placeholder="https://" required={required} maxLength={500} />
  </>
);
const SeenOn = () => (
  <>
    <label htmlFor="seenOn">When did you see it?</label>
    <input id="seenOn" name="seenOn" type="date" max={new Date().toISOString().slice(0, 10)} />
  </>
);
const DishName = ({ dish, required = false }: { dish: { id: string; label: string } | null; required?: boolean }) =>
  dish ? (
    <input type="hidden" name="dish" value={dish.label} />
  ) : (
    <>
      <label htmlFor="dish">Dish name{required ? " (required)" : ""}</label>
      <input id="dish" name="dish" type="text" maxLength={200} required={required} />
    </>
  );

function SuggestionForm({ kind, listing, slug, dish }: { kind: Kind; listing: string | null; slug: string | null; dish: { id: string; label: string } | null }) {
  return (
    <form action={submitSuggestionAction} className="panel stack form-stack" data-testid="contribute-form" data-kind={kind}>
      <h2 className="h-sec" style={{ marginTop: 0 }}>
        {KINDS.find((k) => k.v === kind)!.label}
      </h2>
      <input type="hidden" name="kind" value={kind} />
      {listing && <input type="hidden" name="listing" value={listing} />}
      {slug && <input type="hidden" name="place" value={slug} />}
      {dish && <input type="hidden" name="dishId" value={dish.id} />}
      {kind === "missing_restaurant" && (
        <>
          <label htmlFor="name">Restaurant name (required)</label>
          <input id="name" name="name" type="text" required minLength={2} maxLength={120} />
          <label htmlFor="street">Street address</label>
          <input id="street" name="street" type="text" maxLength={160} />
          <label htmlFor="area">Neighbourhood or town</label>
          <input id="area" name="area" type="text" maxLength={80} />
          <label htmlFor="website">Its own website</label>
          <input id="website" name="website" type="url" placeholder="https://" maxLength={300} />
        </>
      )}
      {kind === "missing_dish" && (
        <>
          <DishName dish={null} required />
          <fieldset>
            <legend>What does the restaurant say about it? (required)</legend>
            <label className="check">
              <input type="radio" name="diet" value="vegan" required /> <span>It says vegan</span>
            </label>
            <label className="check">
              <input type="radio" name="diet" value="vegetarian" /> <span>It says vegetarian</span>
            </label>
            <label className="check">
              <input type="radio" name="diet" value="not_stated" /> <span>It doesn&rsquo;t say, but it looks meat-free</span>
            </label>
          </fieldset>
          <label htmlFor="quote">The restaurant&rsquo;s own words, if any (a short quote)</label>
          <input id="quote" name="quote" type="text" maxLength={300} />
          <Source />
          <Url />
          <SeenOn />
        </>
      )}
      {kind === "diet_info" && (
        <>
          <DishName dish={dish} />
          <label htmlFor="diet">What does the restaurant say? (required)</label>
          <select id="diet" name="diet" required defaultValue="">
            <option value="" disabled>
              Choose one
            </option>
            {DIET_CLAIMS.map((d) => (
              <option key={d.v} value={d.v}>
                {d.label}
              </option>
            ))}
          </select>
          <label htmlFor="quote">Their exact words (required, a short quote)</label>
          <input id="quote" name="quote" type="text" required minLength={3} maxLength={300} />
          <Source />
          <Url />
          <SeenOn />
        </>
      )}
      {kind === "ingredients" && (
        <>
          <DishName dish={dish} />
          <label htmlFor="ingredients">Ingredients, as the restaurant lists them (required)</label>
          <textarea id="ingredients" name="ingredients" required minLength={3} maxLength={1000} rows={4} />
          <Source />
          <Url />
          <SeenOn />
        </>
      )}
      {kind === "menu_correction" && (
        <>
          <DishName dish={dish} />
          <label htmlFor="field">What&rsquo;s wrong? (required)</label>
          <select id="field" name="field" required defaultValue="">
            <option value="" disabled>
              Choose one
            </option>
            {FIELDS.map((f) => (
              <option key={f.v} value={f.v}>
                {f.label}
              </option>
            ))}
          </select>
          <label htmlFor="wrong">What we show</label>
          <input id="wrong" name="wrong" type="text" maxLength={300} />
          <label htmlFor="right">What it should say (required)</label>
          <input id="right" name="right" type="text" required maxLength={300} />
          <Source />
          <Url />
        </>
      )}
      {kind === "price" && (
        <>
          <DishName dish={dish} />
          <label htmlFor="price">Price in dollars (required)</label>
          <input id="price" name="price" type="text" inputMode="decimal" pattern="\d{1,4}(\.\d{2})?" placeholder="12.50" required />
          <Source />
          <SeenOn />
        </>
      )}
      {kind === "nutrition_source" && (
        <>
          <DishName dish={dish} />
          <Url required label="Link to the restaurant's nutrition page or PDF" />
          <label htmlFor="protein">Protein it shows, in grams, if you&rsquo;d like to note it</label>
          <input id="protein" name="protein" type="text" inputMode="decimal" pattern="\d{1,3}(\.\d)?" />
          <label htmlFor="unit">Per</label>
          <select id="unit" name="unit" defaultValue="per_serving">
            <option value="per_serving">Serving</option>
            <option value="per_100g">100 g</option>
          </select>
        </>
      )}
      {kind === "stale_menu" && (
        <>
          <label htmlFor="note">What has changed? (required)</label>
          <textarea id="note" name="note" required minLength={3} maxLength={500} rows={3} />
          <Source />
          <Url />
          <SeenOn />
        </>
      )}
      {kind === "branch_correction" && (
        <>
          <label htmlFor="field">What&rsquo;s wrong? (required)</label>
          <select id="field" name="field" required defaultValue="">
            <option value="" disabled>
              Choose one
            </option>
            {BRANCH_FIELDS.map((f) => (
              <option key={f.v} value={f.v}>
                {f.label}
              </option>
            ))}
          </select>
          <label htmlFor="wrong">What we show</label>
          <input id="wrong" name="wrong" type="text" maxLength={300} />
          <label htmlFor="right">What is right now (required)</label>
          <input id="right" name="right" type="text" required minLength={2} maxLength={300} />
          <Source />
          <Url />
          <SeenOn />
        </>
      )}
      {kind === "duplicate_restaurant" && (
        <>
          <label htmlFor="right">The other listing: its name and street (required)</label>
          <input id="right" name="right" type="text" required minLength={2} maxLength={200} />
          <Url label="A link to the other listing, if you have it" />
        </>
      )}
      {kind !== "stale_menu" && (
        <>
          <label htmlFor="note">Anything else</label>
          <textarea id="note" name="note" maxLength={500} rows={2} />
        </>
      )}
      <label className="check">
        <input type="checkbox" name="agree" value="yes" required data-testid="contribute-agree" />
        <span>
          This is what I saw or a link to it, not text or photos copied from somewhere I don&rsquo;t have the right to share. I understand it is a
          lead for checking, not a confirmed fact.
        </span>
      </label>
      <div className="row">
        <button className="btn primary" type="submit" data-testid="contribute-send">
          Send suggestion
        </button>
        <Link className="link-btn" href={`/contribute${slug ? `?place=${slug}` : ""}`}>
          Back
        </Link>
      </div>
    </form>
  );
}

export default function ContributePage({ searchParams }: { searchParams: Promise<RawParams> }) {
  return (
    <AppShell active="discover">
      <h1 className="title">Suggest a change</h1>
      <p className="s14 muted" style={{ marginTop: 0 }}>
        Help us find more good vegetarian and vegan food. Every suggestion is checked at its source before anything changes.
      </p>
      <Suspense fallback={<Loading label="Loading…" />}>
        <Contribute searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}
