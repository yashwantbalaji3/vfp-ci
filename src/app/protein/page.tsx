import { Suspense } from "react";
import { FreshnessNote } from "@/components/editor/bits";
import { Fresh } from "@/components/freshness";
import Link from "next/link";
import { FLAGS } from "@/config/flags";
import { redirect } from "next/navigation";
import { AppShell, Loading } from "@/components/app-shell";
import { DietChip } from "@/components/diet-chip";
import { DietaryConfidence, EvidenceBadge, ProteinFigure } from "@/components/labels";
import { BASES, type Basis, type FoodDetail, type SearchItem } from "@/contracts/catalog";
import { hasDietChoice, hiddenReasonText } from "@/domain/dietary/labels";
import { KIND_LABELS, formatAmount, formatDate, methodLabel, proteinFor, proteinRangeFor, reasonText } from "@/lib/format";
import { PROTEIN_KIND_TABS, hrefWith, parseProteinParams, toggleCompare, type RawParams } from "@/lib/search-params";
import { compareFoods, searchCatalog } from "@/server/catalog";
import { readDietPreference } from "@/server/catalog/diet";
import { limitNotice } from "@/components/too-many-requests";
import { pageLimit } from "@/server/page-limit";
import { getPreviewAudience, getPreviewIndex } from "@/server/catalog/menu-preview";

export const metadata = { title: "Protein Explorer" };
const BASIS_LABELS: Record<Basis, string> = { serving: "Per serving", "100g": "Per 100 g", "100kcal": "Per 100 kcal" };

/** One food's figure in words: exact as it is, an estimate as "about" with its range, unknown with its reason. */
function figureText(value: number | null, reason: string | null, unit: string, method: string | null, range: { low: number; high: number } | null = null) {
  if (value === null) return reasonText(reason);
  if (method !== "estimated") return `${formatAmount(value)} ${unit}`;
  return `about ${formatAmount(value)} ${unit} (estimate${range ? ` ${formatAmount(range.low)}–${formatAmount(range.high)} ${unit}` : ""})`;
}

/**
 * Comparison of up to three foods, built for 320–430 px phones first: a bar for each food on the
 * chosen basis (an estimate is drawn as its range with a dot at the middle figure, an unknown value
 * gets no bar), then one card per food. Cards sit side by side on wider screens. No table, so
 * nothing scrolls sideways.
 */
function ComparePanel({ foods, sp, compare, basis }: { foods: FoodDetail[]; sp: RawParams; compare: string[]; basis: Basis }) {
  const unavailable = foods.filter((f) => proteinFor(f.protein, basis).value === null);
  const scale = Math.max(
    1,
    ...foods.map((f) => proteinRangeFor(f.protein, basis)?.high ?? proteinFor(f.protein, basis).value ?? 0),
  );
  const pct = (n: number) => `${Math.max(0, Math.min(100, (n / scale) * 100)).toFixed(1)}%`;
  return (
    <section className="compare" aria-labelledby="compare-h" data-testid="compare-panel">
      <h2 className="h-sec" id="compare-h" style={{ marginTop: 0 }}>
        Comparing {foods.length} of up to 3
      </h2>
      {unavailable.length > 0 && foods.length > 1 && (
        <p className="callout s14" data-testid="compare-basis-warning">
          {unavailable.map((f) => f.name).join(" and ")} can&rsquo;t be compared {BASIS_LABELS[basis].toLowerCase()}. Try another basis below to compare like with
          like.
        </p>
      )}

      <h3 className="s14" style={{ margin: "0 0 6px" }} id="cmp-bars-h">
        Protein {BASIS_LABELS[basis].toLowerCase()}
      </h3>
      <ul className="cmp-bars" aria-labelledby="cmp-bars-h" data-testid="compare-bars">
        {foods.map((f) => {
          const view = proteinFor(f.protein, basis);
          const range = proteinRangeFor(f.protein, basis);
          const estimated = f.protein.method === "estimated" && view.value !== null;
          return (
            <li key={f.foodItemId} data-testid="compare-bar" data-state={view.value === null ? "unknown" : estimated ? "estimated" : f.protein.method ?? "unknown"}>
              <div className="cmp-bar-label">
                <span className="cmp-bar-name">{f.name}</span>
                <span className={`cmp-bar-value ${view.value === null ? "none" : ""}`}>{figureText(view.value, view.reason, "g", f.protein.method, range)}</span>
              </div>
              {view.value !== null && (
                <div className="cmp-track" aria-hidden="true">
                  {estimated && range ? (
                    <>
                      <span className="cmp-range" style={{ left: pct(range.low), width: `calc(${pct(range.high)} - ${pct(range.low)})` }} />
                      <span className="cmp-dot" style={{ left: pct(view.value) }} />
                    </>
                  ) : (
                    <span className={`cmp-fill ${estimated ? "est" : ""}`} style={{ width: pct(view.value) }} />
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <p className="s13 muted" style={{ margin: "4px 0 12px" }}>
        A solid bar is a published or calculated figure. A pale band is an estimate&rsquo;s range, with a dot at its most likely value. No bar means the value isn&rsquo;t known; it is not zero.
      </p>

      <ul className="cmp-cards">
        {foods.map((f) => {
          const range = (b: Basis) => proteinRangeFor(f.protein, b);
          return (
            <li key={f.foodItemId} className="cmp-card" data-testid="compare-card">
              <Link className="name link" href={`/foods/${f.foodItemId}`}>
                {f.name}
              </Link>
              <div className="s13 muted">{f.venue ? f.venue.name : KIND_LABELS[f.kind]}</div>
              <div style={{ margin: "6px 0" }}>
                <EvidenceBadge method={f.protein.method} known={f.protein.basisValue !== null} />
              </div>
              <dl className="cmp-facts">
                <div>
                  <dt>Protein per serving</dt>
                  <dd>{figureText(f.protein.perServing, f.protein.perServingReason, "g", f.protein.method, range("serving"))}</dd>
                </div>
                <div>
                  <dt>Protein per 100 g</dt>
                  <dd>{figureText(f.protein.per100g, f.protein.per100gReason, "g", f.protein.method, range("100g"))}</dd>
                </div>
                <div>
                  <dt>Protein per 100 kcal</dt>
                  <dd>{figureText(f.protein.per100kcal, f.protein.per100kcalReason, "g", f.protein.method, range("100kcal"))}</dd>
                </div>
                <div>
                  <dt>Energy per serving</dt>
                  <dd>{figureText(f.protein.energyKcalPerServing, "energy_not_provided", "kcal", f.protein.energyMethod)}</dd>
                </div>
                <div>
                  <dt>Serving</dt>
                  <dd>
                    {f.protein.servingLabel ?? "Not stated"}
                    {f.protein.servingGrams !== null ? ` (${formatAmount(f.protein.servingGrams)} g)` : " (weight not provided)"}
                  </dd>
                </div>
                <div>
                  <dt>How we know</dt>
                  <dd>
                    {f.protein.basisValue !== null ? methodLabel(f.protein.method) : "No value"}
                    {formatDate(f.publishedAt) ? ` · checked ${formatDate(f.publishedAt)}` : ""}
                  </dd>
                </div>
              </dl>
              <div className="row" style={{ marginTop: 8 }}>
                <Link className="link-btn" href={`/foods/${f.foodItemId}#how-h`}>
                  Evidence<span className="sr-only"> for {f.name}</span>
                </Link>
                <Link className="link-btn" href={hrefWith("/protein", sp, { compare: toggleCompare(compare, f.foodItemId).join(",") || null })}>
                  Remove<span className="sr-only"> {f.name} from comparison</span>
                </Link>
              </div>
              <Fresh food={f.foodItemId} block />
            </li>
          );
        })}
      </ul>
      <p className="s14 muted" style={{ marginBottom: 0 }}>
        Open any food to see its place, save it or read every source. Your comparison stays in this page&rsquo;s address, so you can come back to it.
      </p>
    </section>
  );
}

/** "4.2 g protein per $1 · $13.50 for 1 bowl, price checked 18 Nov 2026", or why it can't be worked out. */
function perDollarText(item: SearchItem): string {
  const price = item.price;
  const priceText = price
    ? `$${(price.amountMinor / 100).toFixed(2)}${price.servingDescription ? ` for ${price.servingDescription}` : ""}, price checked ${formatDate(price.checkedAt) ?? "on a recorded date"}`
    : null;
  if (item.proteinPerDollar !== null && priceText) return `${formatAmount(item.proteinPerDollar)} g protein per $1 · ${priceText}`;
  if (!priceText) return "No dated price yet, so it can’t be ranked per dollar.";
  return `${priceText}. No published or calculated protein per serving, so it can’t be ranked per dollar.`;
}

function Row({ item, position, basis, sp, compare, diet, perDollar = false }: { item: SearchItem; position: number | null; basis: Basis; sp: RawParams; compare: string[]; diet: Awaited<ReturnType<typeof readDietPreference>>; perDollar?: boolean }) {
  const selected = compare.includes(item.foodItemId);
  const full = compare.length >= 3 && !selected;
  const view = proteinFor(item.protein, basis);
  return (
    <li data-testid={position ? "ranked-row" : "unranked-row"}>
      <span className="pos" aria-hidden={position ? undefined : true}>
        {position ?? "–"}
      </span>
      <div>
        <Link className="name link" href={`/foods/${item.foodItemId}`}>
          {item.name}
        </Link>
        <div className="s14 muted">{item.venue ? `${KIND_LABELS[item.kind]} · ${item.venue.name}` : [KIND_LABELS[item.kind], item.brand].filter(Boolean).join(" · ")}</div>
        <div className="line" style={{ marginTop: 4 }}>
          <ProteinFigure protein={item.protein} basis={basis} large={position !== null} />
          {view.value !== null && <EvidenceBadge method={item.protein.method} known />}
          <DietaryConfidence eligibility={item.eligibility} choice={diet} />
          <FreshnessNote mark={item.freshness} />
        </div>
        {perDollar && (
          <div className="s14" style={{ marginTop: 4 }} data-testid="row-per-dollar">
            {perDollarText(item)}
          </div>
        )}
      </div>
      <div className="actions">
        {full ? (
          <span className="btn" aria-disabled="true" role="link" title="Remove one to add another">
            Compare is full (3)
          </span>
        ) : (
          <Link className="btn" href={hrefWith("/protein", sp, { compare: toggleCompare(compare, item.foodItemId).join(",") || null })}>
            {selected ? (
              <>
                Remove<span className="sr-only"> from compare</span>
              </>
            ) : (
              "Compare"
            )}
            <span className="sr-only"> {item.name}</span>
          </Link>
        )}
      </div>
    </li>
  );
}

async function Explorer({ searchParams }: { searchParams: Promise<RawParams> }) {
  const refused = limitNotice(await pageLimit());
  if (refused) return refused;
  const sp = await searchParams;
  const { filters, kind, compare, perDollar } = parseProteinParams(sp);
  const diet = await readDietPreference();
  let result, compared: FoodDetail[];
  try {
    [result, compared] = await Promise.all([
      searchCatalog(filters, diet),
      compare.length ? compareFoods(compare, filters.includeEstimates).catch(() => []) : Promise.resolve([]),
    ]);
  } catch {
    return (
      <div className="callout stop" role="alert">
        <strong>We couldn&rsquo;t load Protein Explorer just now.</strong> <Link href={hrefWith("/protein", sp, {})}>Try again</Link>
      </div>
    );
  }
  const basis = filters.basis;
  const canRank = (i: SearchItem) => (perDollar ? i.proteinPerDollar !== null : proteinFor(i.protein, basis).value !== null);
  const ranked = result.items.filter(canRank);
  const unranked = result.items.filter((i) => !canRank(i));
  const rankLabel = perDollar ? "per dollar" : BASIS_LABELS[basis].toLowerCase();
  const leftOut = result.counts.notPricedComparable;
  const strict = hasDietChoice(diet);
  const inNeeds = filters.view === "needs_confirmation";

  const [preview, audience] = await Promise.all([getPreviewIndex().catch(() => null), getPreviewAudience().catch(() => null)]);
  // Real mode with nothing in the catalog ranking: send the founder straight to the real restaurant meals
  // rather than an empty ranking (docs/62).
  if (FLAGS.realDiscovery && preview && preview.length > 0 && result.counts.matches + result.counts.needsConfirmation === 0 && !filters.q && compare.length === 0)
    redirect(`/protein/meals${diet.diet === "none" ? "" : `?diet=${diet.diet}`}`);
  return (
    <>
      {preview && preview.length > 0 && (
        <p className="callout" data-testid="protein-real-meals">
          <strong>Unverified preview:</strong>{" "}
          <Link href={`/protein/meals${diet.diet === "none" ? "" : `?diet=${diet.diet}`}`}>real meals from {preview.length} Boston-area restaurants</Link>, sorted by protein. {audience === "member_beta" ? "A local beta: test accounts on this computer only." : "Only you can see them."}
        </p>
      )}
      <div className="chips" style={{ marginBottom: 12 }}>
        <DietChip diet={diet} returnTo={hrefWith("/protein", sp, {})} />
      </div>
      <nav className="seg" aria-label="Comparison basis">
        {BASES.map((b) => (
          <Link key={b} href={hrefWith("/protein", sp, { basis: b === "serving" ? null : b, rank: null })} aria-current={!perDollar && basis === b ? "true" : undefined}>
            {BASIS_LABELS[b]}
          </Link>
        ))}
        <Link href={hrefWith("/protein", sp, { rank: "dollar", basis: null, kind: null })} aria-current={perDollar ? "true" : undefined}>
          Per dollar
        </Link>
      </nav>
      {perDollar ? (
        <p className="s14 muted" style={{ margin: "12px 0" }} data-testid="per-dollar-note">
          Restaurant dishes only, by protein per serving and the newest dated menu price. A dish is ranked only when both numbers have a source. Estimates are never ranked per dollar.
        </p>
      ) : (
        <nav className="chips scroll" aria-label="Kind of food" style={{ margin: "12px 0" }}>
          {PROTEIN_KIND_TABS.map((t) => (
            <Link key={t.key} className="chip" href={hrefWith("/protein", sp, { kind: t.key === "all" ? null : t.key })} aria-current={kind === t.key ? "true" : undefined}>
              {t.label}
            </Link>
          ))}
        </nav>
      )}
      <p className="s14" style={{ margin: "0 0 4px" }}>
        {filters.includeEstimates ? (
          <>
            Estimated restaurant figures are included and labelled.{" "}
            <Link className="link" href={hrefWith("/protein", sp, { est: null })}>
              Hide estimates
            </Link>
          </>
        ) : (
          <>
            Showing published and calculated values only.{" "}
            <Link className="link" href={hrefWith("/protein", sp, { est: "1" })}>
              Include estimates
            </Link>
          </>
        )}
      </p>

      {compared.length > 0 && <ComparePanel foods={compared} sp={sp} compare={compare} basis={basis} />}
      {compare.length > 0 && compared.length === 0 && (
        <p className="callout">
          The foods in this comparison are no longer available. <Link href={hrefWith("/protein", sp, { compare: null })}>Clear the comparison</Link>
        </p>
      )}

      {strict && (
        <nav className="seg" aria-label="Result groups" style={{ margin: "12px 0" }}>
          <Link href={hrefWith("/protein", sp, { view: null })} aria-current={!inNeeds ? "true" : undefined}>
            Confirmed ({result.counts.matches})
          </Link>
          <Link href={hrefWith("/protein", sp, { view: "needs_confirmation" })} aria-current={inNeeds ? "true" : undefined}>
            Needs confirmation ({result.counts.needsConfirmation})
          </Link>
        </nav>
      )}
      {inNeeds && (
        <p className="callout">
          <strong>Not confirmed.</strong> These foods have an ingredient nobody has confirmed for your filter. They are not matches.
        </p>
      )}

      <h2 className="h-sec" id="rank-h">
        {perDollar ? "Most protein per dollar" : <>Most protein, {rankLabel}</>}
      </h2>
      {perDollar && leftOut > 0 && (
        <p className="s14 muted" data-testid="per-dollar-left-out">
          {leftOut === 1
            ? "1 dish is left out of this ranking because it doesn’t have both a published or calculated protein figure and a dated price."
            : `${leftOut} dishes are left out of this ranking because they don’t have both a published or calculated protein figure and a dated price.`}
        </p>
      )}
      {result.counts.matches > result.items.length && !inNeeds && (
        <p className="s14 muted" data-testid="list-truncated">
          Showing the first {result.items.length} of {result.counts.matches}. Choose a kind of food above to narrow the list.
        </p>
      )}
      {ranked.length > 0 ? (
        <ol className="rank" aria-labelledby="rank-h">
          {ranked.map((item, i) => (
            <Row key={item.foodItemId} item={item} position={i + 1} basis={basis} sp={sp} compare={compare} diet={diet} perDollar={perDollar} />
          ))}
        </ol>
      ) : (
        <p className="muted" data-testid="empty-state">
          Nothing can be ranked {rankLabel} with these choices.
        </p>
      )}

      {unranked.length > 0 && (
        <>
          <h2 className="h-sec" id="unranked-h">
            Can&rsquo;t be ranked {rankLabel}
          </h2>
          <p className="s14 muted" style={{ marginTop: 0 }}>
            A missing number is not zero, so these are listed separately instead of at the bottom of the ranking.
          </p>
          <ul className="rank" aria-labelledby="unranked-h">
            {unranked.map((item) => (
              <Row key={item.foodItemId} item={item} position={null} basis={basis} sp={sp} compare={compare} diet={diet} perDollar={perDollar} />
            ))}
          </ul>
        </>
      )}
      {strict && result.counts.hidden > 0 && (
        <p className="s14 muted" style={{ marginTop: 12 }}>
          Always hidden for your filter: {result.hiddenReasons.map((r) => hiddenReasonText(r.code, r.family, r.count)).join(", ")}.
        </p>
      )}
    </>
  );
}

export default function ProteinPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  return (
    <AppShell active="protein">
      <p className="eyebrow">Dishes, recipes and packaged foods</p>
      <h1 className="title">Protein Explorer</h1>
      <Suspense fallback={<Loading label="Ranking foods…" />}>
        <Explorer searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}
