import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell, Loading } from "@/components/app-shell";
import { SignInPrompt } from "@/components/social/bits";
import { FLAGS } from "@/config/flags";
import { CORRECTABLE, factLabel, factWords, type MenuFact } from "@/contracts/menu-review";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { getMenuPlace } from "@/server/catalog/menu-review";
import { SocialError } from "@/server/social";
import { FounderOnly } from "../../../../bits";
import { correctFactAction } from "../../../actions";

export const metadata = { title: "Correct a fact", robots: { index: false, follow: false } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const ERRORS: Record<string, string> = {
  INVALID_CORRECTION: "That value doesn't fit. Check the format and try again.",
  STAGING_ALREADY_REVIEWED: "This fact was already decided.",
};

function Fields({ f }: { f: MenuFact }) {
  const v = (f.value ?? {}) as Record<string, unknown>;
  switch (f.kind) {
    case "price":
      return (
        <div>
          <label htmlFor="fix-usd">Price in dollars (for example 12.50)</label>
          <input id="fix-usd" name="usd" inputMode="decimal" defaultValue={String(v.usd ?? "")} required pattern="[0-9]{1,4}(\.[0-9]{2})?" />
        </div>
      );
    case "listed_ingredients":
      return (
        <div>
          <label htmlFor="fix-items">Ingredients the restaurant lists, separated by commas</label>
          <textarea id="fix-items" name="items" rows={3} style={{ width: "100%" }} defaultValue={Array.isArray(v.items) ? (v.items as unknown[]).join(", ") : ""} required />
        </div>
      );
    case "serving_size":
      return (
        <div>
          <label htmlFor="fix-grams">Serving size in grams</label>
          <input id="fix-grams" name="grams" inputMode="decimal" defaultValue={String(v.grams ?? "")} required />
        </div>
      );
    case "published_nutrition":
      return (
        <>
          <div>
            <label htmlFor="fix-amount">Amount the restaurant publishes</label>
            <input id="fix-amount" name="amount" inputMode="decimal" defaultValue={String(v.amount ?? "")} required />
          </div>
          <fieldset className="row-choice">
            <legend>Per</legend>
            <label>
              <input type="radio" name="per" value="serving" defaultChecked={v.per !== "100g"} /> Serving
            </label>
            <label>
              <input type="radio" name="per" value="100g" defaultChecked={v.per === "100g"} /> 100 g
            </label>
          </fieldset>
        </>
      );
    case "dietary_status":
      return (
        <fieldset className="row-choice">
          <legend>Does the restaurant say this dish is {factLabel(f).toLowerCase()}?</legend>
          <label>
            <input type="radio" name="status" value="yes" required /> Yes, the restaurant says so
          </label>
          <label>
            <input type="radio" name="status" value="no" /> No
          </label>
        </fieldset>
      );
    case "menu_item":
      return (
        <fieldset className="row-choice">
          <legend>Is it on the menu?</legend>
          <label>
            <input type="radio" name="listed" value="true" required /> Yes
          </label>
          <label>
            <input type="radio" name="listed" value="false" /> No
          </label>
        </fieldset>
      );
    default:
      return null;
  }
}

async function Fix({ params, searchParams }: { params: Promise<{ placeId: string; factId: string }>; searchParams: Promise<RawParams> }) {
  const { placeId, factId } = await params;
  if (!UUID.test(placeId) || !UUID.test(factId)) notFound();
  const sp = await searchParams;
  const member = await getCurrentMember();
  if (!member) {
    return (
      <SignInPrompt next={`/places/review/menus/${placeId}/fix/${factId}`}>
        <p>Menu review is for the founder. Sign in to continue.</p>
      </SignInPrompt>
    );
  }
  let fact: MenuFact | undefined;
  let dish = "";
  try {
    const place = await getMenuPlace(placeId);
    for (const d of place.dishes) {
      const f = d.facts.find((x) => x.factId === factId);
      if (f) {
        fact = f;
        dish = d.label;
      }
    }
  } catch (e) {
    if (e instanceof SocialError && (e.status === 403 || e.status === 401)) return <FounderOnly />;
    if (e instanceof SocialError && e.status === 404) notFound();
    throw e;
  }
  if (!fact || fact.status !== "submitted" || !CORRECTABLE.includes(fact.kind)) notFound();
  const e = first(sp.e);
  return (
    <>
      <h1 className="title" style={{ overflowWrap: "anywhere" }}>
        Correct: {dish}
      </h1>
      <p>
        Drafted {factLabel(fact).toLowerCase()}: <strong data-testid="fix-drafted">{factWords(fact)}</strong>
      </p>
      {e && (
        <p className="callout stop" role="alert" data-testid="fix-error">
          {ERRORS[e] ?? "That was not saved. Please try again."}
        </p>
      )}
      <form action={correctFactAction} className="stack" data-testid="fix-form">
        <input type="hidden" name="placeId" value={placeId} />
        <input type="hidden" name="factId" value={factId} />
        <Fields f={fact} />
        <div>
          <label htmlFor="fix-note">What was wrong? (optional)</label>
          <textarea id="fix-note" name="note" maxLength={500} rows={2} style={{ width: "100%" }} />
        </div>
        <button className="btn primary" type="submit" data-testid="fix-save">
          Save correction
        </button>
        <p className="s14 muted" style={{ margin: 0 }}>
          Your correction sets the draft aside. Research redrafts it from the source, and it comes back to you to confirm, so no one confirms their own entry.
        </p>
      </form>
      <p>
        <Link href={`/places/review/menus/${placeId}`}>Cancel</Link>
      </p>
    </>
  );
}

export default function FixPage({ params, searchParams }: { params: Promise<{ placeId: string; factId: string }>; searchParams: Promise<RawParams> }) {
  if (!FLAGS.realCatalogPreview) notFound();
  return (
    <AppShell active="discover" realPlaces>
      <p className="eyebrow">Private · founder only</p>
      <Suspense fallback={<Loading label="Loading…" />}>
        <Fix params={params} searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}
