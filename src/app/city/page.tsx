import { Suspense } from "react";
import { AppShell, Loading } from "@/components/app-shell";
import { MARKET_ORDER, MARKETS } from "@/config/markets";
import { safeReturnPath } from "@/lib/format";
import type { RawParams } from "@/lib/search-params";
import { readMarket } from "@/server/market";
import { chooseCity } from "./actions";

export const metadata = { title: "Choose your city" };

async function CityForm({ searchParams }: { searchParams: Promise<RawParams> }) {
  const sp = await searchParams;
  const returnTo = safeReturnPath(Array.isArray(sp.return) ? sp.return[0] : sp.return);
  const current = await readMarket();
  return (
    <form action={chooseCity} className="panel" data-testid="city-form">
      <input type="hidden" name="return" value={returnTo} />
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="s14 muted" style={{ marginBottom: 8 }}>
          Each area reaches about 25 miles from the city centre. Saved on this browser only.
        </legend>
        <div className="choice-list">
          {MARKET_ORDER.map((slug) => {
            const m = MARKETS[slug];
            return (
              <label key={slug} className="check" data-testid={`city-${slug}`}>
                <input type="radio" name="market" value={slug} defaultChecked={current.slug === slug} />
                <span>
                  {m.city}, {m.state}
                  <span className="hint">{m.discovery === "open" ? "Restaurants and meals being added now" : "Recipes, diary and Protein Explorer now; restaurants later"}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <button className="btn primary" type="submit" style={{ marginTop: 12 }} data-testid="city-save">
        Use this city
      </button>
    </form>
  );
}

export default function CityPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  return (
    <AppShell active="discover">
      <h1 className="title">Choose your city</h1>
      <Suspense fallback={<Loading />}>
        <CityForm searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}
