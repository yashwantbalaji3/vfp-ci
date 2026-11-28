import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell, Loading } from "@/components/app-shell";
import { SignInPrompt } from "@/components/social/bits";
import { FLAGS } from "@/config/flags";
import {
  cleanGroups,
  isException,
  rowFlags,
  type Flag,
} from "@/contracts/menu-prechecks";
import {
  CORRECTABLE,
  DISH_TYPE_WORDS,
  KIND_WORDS,
  areaWords,
  estimateWords,
  factLabel,
  factWords,
  rowConfirmable,
  rowPrivatePilot,
  rowWaiting,
  type MenuDish,
  type MenuFact,
  type MenuPlace,
  LADDER_STEPS,
  ladderCounts,
} from "@/contracts/menu-review";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { getMenuPlace } from "@/server/catalog/menu-review";
import { SocialError } from "@/server/social";
import { FounderOnly } from "../../bits";
import { confirmCleanGroupAction, decideRowsAction } from "../actions";

export const metadata = {
  title: "Check a menu",
  robots: { index: false, follow: false },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const first = (v: string | string[] | undefined) =>
  Array.isArray(v) ? v[0] : v;
const day = (iso: string) =>
  new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", {
    dateStyle: "medium",
    timeZone: "America/New_York",
  });
const ERRORS: Record<string, string> = {
  NOTHING_CHOSEN:
    "Nothing was saved: choose Confirm or Reject on at least one row.",
  STAGING_SAME_PERSON:
    "You entered one of these facts yourself, so someone else has to check it.",
  STAGING_SOURCE_NOT_CLEARED:
    "One of these facts comes from a source that is not cleared yet, so it cannot be confirmed.",
  STAGING_NOT_PRIVATE_PILOT:
    "One of these facts comes from a source that is not in the private pilot, so it cannot be confirmed.",
  STAGING_ALREADY_REVIEWED:
    "Some of these facts were already decided. The page now shows where things stand.",
  NOT_CORRECTABLE: "That fact can't be corrected here.",
  FOUNDER_ONLY: "Only the founder can check menus.",
  NOT_FOUND: "We couldn't find that restaurant.",
  NOT_COMPARED:
    "Nothing was saved: tick the box to say you compared these rows with the source.",
  NOT_ACCEPTED:
    "Nothing was saved: tick the box to say you accept the automatic comparison for these rows.",
  AUTOMATIC_NOT_AVAILABLE:
    "Nothing was saved: the automatic comparison no longer covers every value in that group. Compare it yourself instead.",
  GROUP_CHANGED:
    "Nothing was saved: that group changed since the page loaded. Have another look.",
  STAGING_NOT_A_SINGLE_PUBLISHED_VALUE:
    "A range or a restaurant's estimate can't be confirmed for publication.",
};
const CONFIDENCE_WORDS = {
  high: "Drafter sure",
  medium: "Drafter fairly sure",
  low: "Drafter unsure",
} as const;

/**
 * Where this restaurant's facts stand on the six publication states (owner decision D1). Each count is read from
 * its own record and they are never added together: a fact found by the automatic comparison has not been reviewed
 * or confirmed by anyone, and a confirmed fact is not publishable unless its source's rights allow reuse.
 */
function PublicationLadder({ place }: { place: MenuPlace }) {
  const facts = place.dishes.flatMap((d) => d.facts);
  if (facts.length === 0) return null;
  const counts = ladderCounts(facts);
  return (
    <section aria-labelledby="ladder-h" className="post" style={{ marginTop: 16 }} data-testid="menu-ladder">
      <h2 id="ladder-h" className="h-sec" style={{ marginTop: 0 }}>
        Where these {facts.length} facts stand
      </h2>
      <ul className="s14" style={{ margin: 0, paddingLeft: 20 }}>
        {LADDER_STEPS.map((step) => (
          <li key={step.key} data-testid="menu-ladder-step" data-step={step.key}>
            {step.words}: <strong>{counts[step.key]}</strong>
          </li>
        ))}
      </ul>
      <p className="s13 muted" style={{ margin: "8px 0 0" }}>
        Separate counts, never added up. Nothing becomes public until its source allows reuse, it passes review and
        publication is switched on for real data, which needs your separate release approval.
      </p>
    </section>
  );
}

function Fact({
  f,
  placeId,
  sourceUrl,
}: {
  f: MenuFact;
  placeId: string;
  sourceUrl?: string;
}) {
  return (
    <div className="fact" data-testid="menu-fact" data-kind={f.kind}>
      <dt>{factLabel(f)}</dt>
      <dd>
        <span style={{ overflowWrap: "anywhere" }}>{factWords(f)}</span>{" "}
        {f.status === "verified" ? (
          <span className="badge ok">Confirmed by you</span>
        ) : f.statuses.transcriptionConfirmed ? (
          <span className="badge ok" data-testid="menu-transcribed" data-basis={f.confirmationBasis ?? "founder"}>
            {f.confirmationBasis === "automatic_comparison"
              ? "Automatic comparison accepted by you, not compared by hand (private only)"
              : "Matches the source (private only)"}
          </span>
        ) : (
          <span className="s14 muted">
            {f.confidence ? CONFIDENCE_WORDS[f.confidence] : "Drafted"}
            {!f.canConfirm && f.canReject && " · source not cleared yet"}
          </span>
        )}
        {f.status === "submitted" &&
          f.canReject &&
          CORRECTABLE.includes(f.kind) && (
            <>
              {" "}
              <Link
                href={`/places/review/menus/${placeId}/fix/${f.factId}`}
                className="s14"
                aria-label={`Correct ${KIND_WORDS[f.kind].toLowerCase()}`}
              >
                Correct
              </Link>
            </>
          )}
        {sourceUrl && (
          <span className="s14 muted"> · checked {day(f.checkedOn)}</span>
        )}
        {f.machineCheck && f.machineCheck.result !== "not_checked" && (
          <span className="s14 muted" data-testid="menu-machine-check" data-result={f.machineCheck.result} style={{ display: "block", overflowWrap: "anywhere" }}>
            Automatic check, not by you:{" "}
            {f.machineCheck.result === "found" ? "found on the saved page" : "not found on the saved page"}
            {f.machineCheck.pageSavedAt ? ` (saved ${day(f.machineCheck.pageSavedAt.slice(0, 10))})` : ""}. {f.machineCheck.detail}
          </span>
        )}
      </dd>
    </div>
  );
}

/**
 * A USDA protein estimate, kept apart from the restaurant's facts: typical amounts written down by
 * research, the USDA food behind each line, and the assumptions. It is not a fact to confirm here and
 * says nothing about whether the dish is vegetarian or vegan.
 */
function Estimate({ e }: { e: NonNullable<MenuDish["estimate"]> }) {
  return (
    <details className="s14" data-testid="menu-estimate" data-state={e.state === "modelled" ? e.result.state : "unknown"}>
      <summary>{estimateWords(e)}</summary>
      {e.state === "modelled" ? (
        <div className="stack" style={{ marginTop: 6 }}>
          <p style={{ margin: 0 }}>
            Worked out from USDA FoodData Central with typical amounts that research wrote down
            {e.evidence === "dish_name"
              ? ", from the ingredients in the dish's name"
              : e.evidence === "listed_ingredients_and_dish_name"
                ? ", from the menu's listed ingredients and the dish's name"
                : ", from the menu's listed ingredients"}
            . {e.modelStatus === "draft" ? "Nobody has reviewed these assumptions yet." : "A second person reviewed these assumptions."} It
            is never shown as the restaurant&rsquo;s figure.
          </p>
          <ul style={{ margin: 0 }}>
            {e.lines.map((l, i) => (
              <li key={i}>
                {l.label}: {l.gramsLow === l.gramsHigh ? `${l.grams} g` : `${l.gramsLow} to ${l.gramsHigh} g`} ({l.usda}, USDA {l.release})
              </li>
            ))}
          </ul>
          {e.assumptions && <p style={{ margin: 0 }}>Assumptions: {e.assumptions}</p>}
        </div>
      ) : null}
    </details>
  );
}

function Dish({
  d,
  place,
  flags,
}: {
  d: MenuDish;
  place: MenuPlace;
  flags: Flag[];
}) {
  const src = new Map(place.sources.map((s) => [s.sourceId, s]));
  const sources = [...new Set(d.facts.map((f) => f.sourceId))]
    .map((id) => src.get(id))
    .filter(Boolean);
  const waiting = rowWaiting(d);
  const confirmable = rowConfirmable(d);
  const name = `row:${d.dishId}`;
  const pilot = rowPrivatePilot(d);
  return (
    <li className="post stack" data-testid="menu-dish">
      <h2 className="h-sec" style={{ margin: 0, overflowWrap: "anywhere" }}>
        {d.label}
      </h2>
      <p className="s14 muted" style={{ margin: 0 }} data-testid="menu-dish-type">
        {d.structure
          ? DISH_TYPE_WORDS[d.structure.type]
          : "Not sorted yet"}
        {d.structure?.section && <> · menu section &ldquo;{d.structure.section}&rdquo;</>}
        {d.structure?.portion && <> · {d.structure.portion}</>}
      </p>
      {flags.length > 0 && (
        <ul className="s14" data-testid="menu-flags" style={{ margin: 0 }}>
          {flags.map((f) => (
            <li key={f.code + f.words} data-level={f.level}>
              {f.level === "check" ? <strong>Check: </strong> : null}
              {f.words}
            </li>
          ))}
        </ul>
      )}
      {d.options.length > 0 && (
        <p className="s14" style={{ margin: 0 }} data-testid="menu-options">
          Options:{" "}
          {d.options
            .map(
              (o) =>
                `${o.kind === "add" ? "add" : o.kind === "remove" ? "remove" : o.kind === "swap" ? "swap to" : "size"} ${o.label}${o.priceDeltaUsd ? ` (${o.priceDeltaUsd.startsWith("-") ? "−$" + o.priceDeltaUsd.slice(1) : "+$" + o.priceDeltaUsd})` : ""}`,
            )
            .join(", ")}
        </p>
      )}
      {d.estimate && <Estimate e={d.estimate} />}
      <dl className="menu-facts">
        {d.facts.map((f) => (
          <Fact
            key={f.factId}
            f={f}
            placeId={place.placeId}
            sourceUrl={src.get(f.sourceId)?.url}
          />
        ))}
      </dl>
      {d.corrections.length > 0 && (
        <p className="s14" data-testid="menu-correction" style={{ margin: 0 }}>
          You corrected{" "}
          {d.corrections.length === 1
            ? "one fact"
            : `${d.corrections.length} facts`}{" "}
          here. Research will redraft from the source and bring it back to you.
        </p>
      )}
      <p className="s14" style={{ margin: 0 }}>
        Compare with{" "}
        {sources.map((s, i) => (
          <span key={s!.sourceId}>
            {i > 0 && ", "}
            <a
              href={s!.url}
              target="_blank"
              rel="noopener noreferrer nofollow"
              style={{ overflowWrap: "anywhere" }}
            >
              {s!.host}
            </a>
          </span>
        ))}
        .
      </p>
      {waiting ? (
        <fieldset className="row-choice" data-testid="menu-row-choice">
          <legend>This row</legend>
          <label>
            <input
              type="radio"
              name={name}
              value="confirm"
              disabled={!confirmable}
            />{" "}
            Everything matches the source
            {pilot && (
              <span className="s14 muted">
                {" "}
                (private check only: this never makes it public)
              </span>
            )}
          </label>
          <label>
            <input type="radio" name={name} value="reject" /> Reject this row
          </label>
          <label>
            <input type="radio" name={name} value="later" defaultChecked />{" "}
            Later
          </label>
          {!confirmable && (
            <p className="s14 muted" style={{ margin: 0 }}>
              Can&rsquo;t be confirmed yet: part of this row comes from a source
              that is not cleared.
            </p>
          )}
        </fieldset>
      ) : (
        <p className="s14 muted" style={{ margin: 0 }}>
          Nothing left to check in this row.
        </p>
      )}
    </li>
  );
}

async function Place({
  params,
  searchParams,
}: {
  params: Promise<{ placeId: string }>;
  searchParams: Promise<RawParams>;
}) {
  const { placeId } = await params;
  if (!UUID.test(placeId)) notFound();
  const sp = await searchParams;
  const member = await getCurrentMember();
  if (!member) {
    return (
      <SignInPrompt next={`/places/review/menus/${placeId}`}>
        <p>Menu review is for the founder. Sign in to continue.</p>
      </SignInPrompt>
    );
  }
  let place: MenuPlace;
  try {
    place = await getMenuPlace(placeId);
  } catch (e) {
    if (e instanceof SocialError && (e.status === 403 || e.status === 401))
      return <FounderOnly />;
    if (e instanceof SocialError && e.status === 404) notFound();
    return (
      <div className="callout stop" role="alert">
        <strong>We couldn&rsquo;t load this menu just now.</strong>{" "}
        <Link href={`/places/review/menus/${placeId}`}>Try again</Link>
      </div>
    );
  }
  const m = first(sp.m);
  const e = first(sp.e);
  const waiting = place.dishes.filter(rowWaiting).length;
  const flags = new Map(place.dishes.map((d) => [d.dishId, rowFlags(d, place)]));
  // Exceptions first, so the founder starts with the rows that need a closer look.
  const ordered = [...place.dishes].sort(
    (a, b) =>
      Number(isException(flags.get(b.dishId)!) && rowWaiting(b)) -
      Number(isException(flags.get(a.dishId)!) && rowWaiting(a)),
  );
  const exceptions = place.dishes.filter(
    (d) => rowWaiting(d) && isException(flags.get(d.dishId)!),
  ).length;
  const groups = cleanGroups(place);
  const hosts = new Map(place.sources.map((s) => [s.sourceId, s]));
  return (
    <>
      <h1
        className="title"
        data-testid="menu-place-name"
        style={{ overflowWrap: "anywhere" }}
      >
        {place.label}
      </h1>
      <p className="muted" style={{ marginTop: 0 }}>
        {areaWords(place.area)}, {place.city}
      </p>
      {m === "saved" && (
        <p className="callout calm" role="status" data-testid="menu-flash">
          Saved: {Number(first(sp.v)) || 0} confirmed,{" "}
          {Number(first(sp.t)) || 0} matched to their source privately,{" "}
          {Number(first(sp.r)) || 0} rejected. Nothing was published.
        </p>
      )}
      {m === "corrected" && (
        <p className="callout calm" role="status" data-testid="menu-flash">
          Correction saved. The draft is set aside, and research will redraft it
          from the source for you to check again.
        </p>
      )}
      {e && (
        <p className="callout stop" role="alert" data-testid="menu-error">
          {ERRORS[e] ?? "That was not saved. Please try again."}
        </p>
      )}
      <h2 className="h-sec">Sources</h2>
      <ul data-testid="menu-sources">
        {place.sources.map((s) => (
          <li key={s.sourceId} style={{ overflowWrap: "anywhere" }}>
            <a href={s.url} target="_blank" rel="noopener noreferrer nofollow">
              {s.url}
            </a>{" "}
            <span className="s14 muted">
              · read {day(s.retrievedAt)} ·{" "}
              {s.access === "cleared"
                ? "cleared to use"
                : s.access === "prohibited"
                  ? "not allowed"
                  : s.access === "private_pilot"
                    ? "private pilot: facts only, never public"
                    : "not cleared yet"}
            </span>
          </li>
        ))}
      </ul>
      <PublicationLadder place={place} />
      {groups.length > 0 && (
        <section className="stack" data-testid="menu-clean-groups">
          <h2 className="h-sec">Rows with no flags</h2>
          <p className="s14" style={{ margin: 0 }}>
            The automatic pre-check found nothing odd in these rows. That is
            not a check by you: open the source, compare, then confirm the
            group. {exceptions} flagged{" "}
            {exceptions === 1 ? "row is" : "rows are"} listed first below, one
            at a time.
          </p>
          {groups.map((g) => {
            const srcs = g.sourceIds.map((id) => hosts.get(id)).filter(Boolean);
            return (
              <form
                key={g.key}
                action={confirmCleanGroupAction}
                className="post stack"
                data-testid="menu-clean-group"
              >
                <input type="hidden" name="placeId" value={place.placeId} />
                <input type="hidden" name="group" value={g.key} />
                <p style={{ margin: 0, overflowWrap: "anywhere" }}>
                  <strong>
                    {g.dishIds.length} {g.dishIds.length === 1 ? "row" : "rows"}
                  </strong>{" "}
                  ({g.facts} facts) from{" "}
                  {srcs.map((s, i) => (
                    <span key={s!.sourceId}>
                      {i > 0 && (i === srcs.length - 1 ? " and " : ", ")}
                      <a href={s!.url} target="_blank" rel="noopener noreferrer nofollow">
                        {s!.kind === "restaurant_nutrition_guide" ? `${s!.host} (nutrition guide)` : s!.host}
                      </a>
                    </span>
                  ))}
                  {g.section && <>, menu section &ldquo;{g.section}&rdquo;</>}
                  {g.method === "transcription"
                    ? ", checked privately: this never makes them public"
                    : ", confirmed against a cleared source"}
                  .
                </p>
                <label>
                  <input type="checkbox" name="compared" value="yes" required />{" "}
                  I compared these {g.dishIds.length} rows with{" "}
                  {srcs.length > 1 ? "these sources" : "the source"} and they match
                </label>
                <button className="btn" type="submit" data-testid="menu-clean-save">
                  Confirm these {g.dishIds.length} rows
                </button>
                {g.automaticAllFound && (
                  <div className="stack" data-testid="menu-clean-automatic" style={{ borderTop: "1px solid var(--line, #ddd)", paddingTop: 8 }}>
                    <p className="s14" style={{ margin: 0 }}>
                      Or, instead: an automatic comparison found every drafted value in these rows on
                      the saved copy of the page. You can accept that without comparing by hand. It is
                      recorded as an accepted automatic comparison, never as your own comparison.
                    </p>
                    <label>
                      <input type="checkbox" name="accepted" value="yes" />{" "}
                      I accept the automatic comparison for these {g.dishIds.length} rows (I did not compare them by hand)
                    </label>
                    <button className="btn" type="submit" name="basis" value="automatic" formNoValidate data-testid="menu-clean-accept-automatic">
                      Accept the automatic comparison for these {g.dishIds.length} rows
                    </button>
                  </div>
                )}
              </form>
            );
          })}
        </section>
      )}
      {place.dishes.length === 0 ? (
        <div className="empty">
          <h2>No dishes drafted yet</h2>
        </div>
      ) : (
        <form
          action={decideRowsAction}
          className="stack"
          data-testid="menu-form"
        >
          <input type="hidden" name="placeId" value={place.placeId} />
          <p>
            Open the source, compare each row, then choose. Rows left on
            &ldquo;Later&rdquo; stay as they are. {waiting} of{" "}
            {place.dishes.length} rows still need you.
          </p>
          <ol className="feed" style={{ listStyle: "none", padding: 0 }}>
            {ordered.map((d) => (
              <Dish
                key={d.dishId}
                d={d}
                place={place}
                flags={flags.get(d.dishId)!}
              />
            ))}
          </ol>
          <div>
            <label htmlFor="menu-note">Note for these choices (optional)</label>
            <textarea
              id="menu-note"
              name="note"
              maxLength={500}
              rows={2}
              style={{ width: "100%" }}
            />
          </div>
          <button
            className="btn primary"
            type="submit"
            data-testid="menu-save"
            disabled={waiting === 0}
          >
            Save my choices
          </button>
          <p className="s14 muted" style={{ margin: 0 }}>
            Confirming says the row matches its source. It does not publish
            anything, and an unknown value stays unknown.
          </p>
        </form>
      )}
    </>
  );
}

export default function MenuPlacePage({
  params,
  searchParams,
}: {
  params: Promise<{ placeId: string }>;
  searchParams: Promise<RawParams>;
}) {
  if (!FLAGS.realCatalogPreview) notFound();
  return (
    <AppShell active="discover" realPlaces>
      <p className="eyebrow">Private · founder only</p>
      <p>
        <Link href="/places/review/menus">← All drafted menus</Link>
      </p>
      <Suspense fallback={<Loading label="Loading the menu…" />}>
        <Place params={params} searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}
