import { Suspense } from "react";
import Link from "next/link";
import { AppShell, Loading } from "@/components/app-shell";
import { safeReturnPath } from "@/lib/format";
import type { RawParams } from "@/lib/search-params";
import { getFilterOptions } from "@/server/catalog";
import { describeDietChoice } from "@/domain/dietary/labels";
import { readDietState } from "@/server/catalog/diet";
import { resolveGuestDietChoice, saveDietPreference } from "./actions";

const COMMON = ["egg", "dairy", "honey"];
const commonFirst = (code: string) => (COMMON.includes(code) ? COMMON.indexOf(code) : COMMON.length);

export const metadata = { title: "Your dietary filter" };

async function DietForm({ searchParams }: { searchParams: Promise<RawParams> }) {
  const sp = await searchParams;
  const returnTo = safeReturnPath(Array.isArray(sp.return) ? sp.return[0] : sp.return);
  const [state, options] = await Promise.all([readDietState(), getFilterOptions()]);
  const diet = state.current;
  return (
    <>
    {state.pendingGuestChoice && (
      <form action={resolveGuestDietChoice} className="callout" data-testid="diet-conflict">
        <input type="hidden" name="return" value={`/diet?return=${encodeURIComponent(returnTo)}`} />
        <p style={{ marginTop: 0 }}>
          Before you signed in, this browser was set to <strong>{describeDietChoice(state.pendingGuestChoice)}</strong>. Your account is set to{" "}
          <strong>{describeDietChoice(diet)}</strong>, and that is what applies now.
        </p>
        <div className="row">
          <button className="btn" type="submit" name="use" value="account">
            Keep my account&rsquo;s filter
          </button>
          <button className="btn" type="submit" name="use" value="browser">
            Use this browser&rsquo;s filter instead
          </button>
        </div>
      </form>
    )}
    <p className="s14 muted" data-testid="diet-where">
      {state.signedIn ? "Saved to your account, so it follows you when you sign in elsewhere. Only you can see it." : "Saved on this browser. Sign in to keep it with your account."}
    </p>
    <form action={saveDietPreference} className="panel">
      <input type="hidden" name="return" value={returnTo} />
      <fieldset>
        <legend>Diet</legend>
        {[
          { value: "none", label: "No diet filter", hint: "Show everything in the catalog." },
          { value: "vegetarian", label: "Vegetarian", hint: "No meat, poultry or fish. Can include eggs, dairy and honey." },
          { value: "vegan", label: "Vegan", hint: "No animal-derived ingredients, including dairy, eggs and honey." },
        ].map((o) => (
          <label key={o.value} className="check">
            <input type="radio" name="diet" value={o.value} defaultChecked={diet.diet === o.value} />
            <span>
              {o.label}
              <span className="hint">{o.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Also leave out</legend>
        <p className="muted s14" style={{ margin: "0 0 4px" }}>
          These apply on top of the diet. For example, choose Vegetarian and Eggs for egg-free vegetarian.
        </p>
        {/* The most common choices first (P2 part 2): eggs, dairy and honey, then the rest as listed. */}
        {[...options.families].sort((a, b) => commonFirst(a.code) - commonFirst(b.code)).map((f) => (
          <label key={f.code} className="check">
            <input type="checkbox" name="exclusions" value={f.code} defaultChecked={diet.exclusions.includes(f.code as never)} />
            <span>{f.label}</span>
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Dishes that need a change</legend>
        <label className="check">
          <input type="checkbox" name="includeConditional" defaultChecked={diet.includeConditional} />
          <span>
            Include dishes that fit only if you ask for a change
            <span className="hint">For example &ldquo;without fish sauce&rdquo;. The change is always shown on the dish.</span>
          </span>
        </label>
      </fieldset>
      <div className="callout calm s14" style={{ marginBottom: 16 }}>
        <strong>How strict filters work.</strong> You only see food that is stated to fit. Food with an unconfirmed ingredient is kept
        in a separate &ldquo;Needs confirmation&rdquo; list that you open yourself. Food that contains something you left out is always
        hidden. This is dietary information, not an allergy-safety guarantee.
      </div>
      <div className="row">
        <button className="btn primary" type="submit">
          Apply filter
        </button>
        <Link className="link-btn" href={returnTo}>
          Cancel
        </Link>
      </div>
    </form>
    </>
  );
}

export default function DietPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  return (
    <AppShell active="none" narrow>
      <h1 className="title">Your dietary filter</h1>
      <p className="muted">It applies everywhere: restaurant dishes, recipes, packaged foods and Protein Explorer.</p>
      <Suspense fallback={<Loading />}>
        <DietForm searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}
