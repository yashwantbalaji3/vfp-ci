import { Suspense } from "react";
import { FreshnessNote } from "@/components/editor/bits";
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { AppShell, Loading } from "@/components/app-shell";
import { SignInPanel } from "@/components/diary/diary-tabs";
import { DietChip } from "@/components/diet-chip";
import { Icon } from "@/components/icons";
import { searchFiltersSchema } from "@/contracts/catalog";
import { MEAL_LABELS } from "@/contracts/diary";
import { portionText } from "@/domain/diary/summary";
import { KIND_LABELS, amountText, formatAmount, formatDay } from "@/lib/format";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { searchCatalog } from "@/server/catalog";
import { readDietPreference } from "@/server/catalog/diet";
import { getCustomFoods, getRecentFoods, searchUsdaFoods } from "@/server/diary";
import { memberClock } from "@/server/diary/clock";
import { chooseUsdaFoodAction, repeatEntryAction } from "../actions";
import { one, targetOf } from "../params";
import { limitNotice } from "@/components/too-many-requests";
import { pageLimit } from "@/server/page-limit";

export const metadata = { title: "Add food" };
type Props = { searchParams: Promise<RawParams> };

async function Add({ searchParams }: Props) {
  const refused = limitNotice(await pageLimit());
  if (refused) return refused;
  const sp = await searchParams;
  const member = await getCurrentMember();
  if (!member) return <SignInPanel next="/diary/add">Sign in to add food to your private diary.</SignInPanel>;
  const clock = await memberClock();
  const target = targetOf(sp, clock);
  const q = (one(sp.q) ?? "").trim().slice(0, 120);
  const diet = await readDietPreference();
  const [recent, own, results, usda] = await Promise.all([
    getRecentFoods(8),
    getCustomFoods(),
    q ? searchCatalog(searchFiltersSchema.parse({ q, limit: 12 }), diet) : Promise.resolve(null),
    q ? searchUsdaFoods(q, 8) : Promise.resolve(null),
  ]);
  const problem = one(sp.problem);
  const here = `/diary/add?${target.query}${q ? `&q=${encodeURIComponent(q)}` : ""}`;

  return (
    <>
      <p className="muted" style={{ marginTop: 0 }} data-testid="add-target">
        {MEAL_LABELS[target.mealSlot]} · {target.date === clock.today ? "Today" : formatDay(target.date)}
      </p>

      {(problem === "usda" || problem === "usda_limit") && (
        <p className="callout stop" role="alert" data-testid="add-usda-problem">
          {problem === "usda_limit"
            ? "You've reached the limit for foods of your own, so this USDA food can't be added."
            : "That USDA food couldn't be opened. Search again and choose it once more."}
        </p>
      )}

      <form action="/diary/add" method="get" role="search" className="searchbar">
        <input type="hidden" name="date" value={target.date} />
        <input type="hidden" name="slot" value={target.mealSlot} />
        <input aria-label="Search dishes, recipes and packaged foods" name="q" type="search" defaultValue={q} placeholder="Search dishes and foods" maxLength={120} />
        <button className="btn primary" type="submit">
          Search
        </button>
      </form>

      {results && (
        <section aria-labelledby="res-h">
          <h2 className="h-sec" id="res-h">
            Results for &ldquo;{q}&rdquo;
          </h2>
          <div className="row" style={{ marginBottom: 8 }}>
            <DietChip diet={diet} returnTo={here} />
          </div>
          {results.items.length === 0 ? (
            <p className="muted" data-testid="add-no-results">
              {usda && usda.length > 0 ? "No dishes or catalog foods match." : "Nothing in the catalog matches. You can write it down yourself below."}
            </p>
          ) : (
            <ul className="entries" data-testid="add-results">
              {results.items.map((item) => (
                <li key={item.foodItemId} className="entry">
                  <div className="entry-main">
                    <Link className="name link" href={`/diary/log?food=${item.foodItemId}&${target.query}`}>
                      {item.name}
                    </Link>
                    <div className="s14 muted">{item.venue ? item.venue.name : KIND_LABELS[item.kind]}</div>
                    <FreshnessNote mark={item.freshness} />
                  </div>
                  <div className="entry-num s14">
                    {item.protein.perServing !== null
                      ? `${amountText(item.protein.perServing, "g", item.protein.method)} protein`
                      : item.protein.per100g !== null
                        ? `${amountText(item.protein.per100g, "g", item.protein.method)} protein per 100 g`
                        : "Protein not provided"}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {usda && usda.length > 0 && (
        <section aria-labelledby="usda-h">
          <h2 className="h-sec" id="usda-h">
            Basic foods from USDA
          </h2>
          <p className="s14 muted" style={{ marginTop: 0 }}>
            Nutrition per 100 g from USDA FoodData Central. USDA does not say whether a food is vegetarian or vegan.
          </p>
          <ul className="entries" data-testid="add-usda">
            {usda.map((f) => (
              <li key={`${f.releaseId}-${f.fdcId}`} className="entry">
                <div className="entry-main">
                  <div className="name">{f.description}</div>
                  <div className="s14 muted">
                    {f.proteinPer100g !== null ? `${formatAmount(f.proteinPer100g)} g protein per 100 g` : "Protein not given by USDA"}
                    {f.category ? ` · ${f.category}` : ""}
                  </div>
                </div>
                <form action={chooseUsdaFoodAction} className="entry-num">
                  <input type="hidden" name="releaseId" value={f.releaseId} />
                  <input type="hidden" name="fdcId" value={f.fdcId} />
                  <input type="hidden" name="date" value={target.date} />
                  <input type="hidden" name="slot" value={target.mealSlot} />
                  <button className="btn" type="submit">
                    Choose<span className="sr-only"> {f.description}</span>
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p style={{ marginTop: 20 }}>
        <Link className="btn" href={`/diary/custom?${target.query}`} data-testid="add-own">
          <Icon name="plus" className="" />
          Write down your own food
        </Link>
      </p>
      <p className="s14 muted" style={{ marginTop: 0 }}>
        For a home-cooked meal, a packaged product or anything not in the catalog. Only a name is needed.
      </p>

      {recent.length > 0 && (
        <section aria-labelledby="recent-h">
          <h2 className="h-sec" id="recent-h">
            Logged recently
          </h2>
          <ul className="entries" data-testid="add-recent">
            {recent.map((r) => (
              <li key={r.entryId} className="entry">
                <div className="entry-main">
                  <div className="name">{r.name}</div>
                  <div className="s14 muted">
                    {portionText(r.portion, r.quantity)} · {r.proteinG !== null ? `${amountText(r.proteinG, "g", r.proteinMethod, r.proteinLow, r.proteinHigh)} protein` : "protein not known"}
                  </div>
                </div>
                <form action={repeatEntryAction} className="entry-num">
                  <input type="hidden" name="idempotencyKey" value={randomUUID()} />
                  <input type="hidden" name="entryId" value={r.entryId} />
                  <input type="hidden" name="date" value={target.date} />
                  <input type="hidden" name="mealSlot" value={target.mealSlot} />
                  <button className="btn" type="submit">
                    Log again<span className="sr-only"> {r.name}</span>
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      )}

      {own.length > 0 && (
        <section aria-labelledby="own-h">
          <h2 className="h-sec" id="own-h">
            Your own foods
          </h2>
          <p className="s14" style={{ marginTop: 0 }}>
            <Link className="link" href="/diary/foods" data-testid="own-manage">
              Change or remove your foods
            </Link>
          </p>
          <ul className="entries" data-testid="add-own-list">
            {own.slice(0, 30).map((f) => (
              <li key={f.foodItemId} className="entry">
                <div className="entry-main">
                  <Link className="name link" href={`/diary/log?food=${f.foodItemId}&${target.query}`}>
                    {f.name}
                  </Link>
                  <div className="s14 muted">{f.proteinG !== null ? `${formatAmount(f.proteinG)} g protein per serving` : "Protein not known"}</div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="s14" style={{ marginTop: 24 }}>
        Looking for a restaurant dish?{" "}
        <Link className="link" href="/discover">
          Browse Discover
        </Link>{" "}
        and press &ldquo;Log this&rdquo; on the dish.
      </p>
    </>
  );
}

export default function AddPage(props: Props) {
  return (
    <AppShell active="diary" narrow>
      <Link className="link-btn" href="/diary">
        <Icon name="back" />
        Food Diary
      </Link>
      <h1 className="title">Add food</h1>
      <Suspense fallback={<Loading />}>
        <Add {...props} />
      </Suspense>
    </AppShell>
  );
}
