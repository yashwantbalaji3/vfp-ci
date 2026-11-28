import { Suspense, useId } from "react";
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { AppShell, Loading } from "@/components/app-shell";
import { DiaryTabs, PrivacyNote, SignInPanel } from "@/components/diary/diary-tabs";
import { IdeasPanel, Summary } from "@/components/diary/day-panels";
import { Icon } from "@/components/icons";
import { CONTEXT_LABELS, DAY_STATUSES, MEAL_LABELS, isoDateSchema, type DiaryDay, type DiaryEntry, type MealSlot } from "@/contracts/diary";
import { addDays } from "@/domain/dates/week";
import { groupByMeal, portionText } from "@/domain/diary/summary";
import { formatAmount, formatDay } from "@/lib/format";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { getDiaryDay, getLoggableFood } from "@/server/diary";
import { idSchema } from "@/contracts/catalog";
import { memberClock } from "@/server/diary/clock";
import { mealSourceWords } from "@/contracts/meal-diary";
import { deleteEntryAction, repeatEntryAction, restoreEntryAction, setDayStatusAction } from "./actions";

export const metadata = { title: "Food Diary" };

/**
 * After logging a restaurant dish: an offer to rate it or open its page (where it can be saved). Both are
 * separate steps the member chooses; the diary entry itself stays private and nothing is posted.
 * Any other food, or a food the member can no longer see, shows nothing here.
 */
async function NextStep({ foodId, date }: { foodId: string; date: string }) {
  const food = await getLoggableFood(foodId).catch(() => null);
  if (!food || food.kind !== "dish" || food.isOwn) return null;
  const back = `/diary?date=${date}`;
  return (
    <div className="panel" data-testid="diary-next-step">
      <p style={{ marginTop: 0 }}>
        <strong>{food.name}</strong>
        {food.venueName ? ` from ${food.venueName}` : ""}. Want to rate it?
      </p>
      <div className="row">
        <Link className="btn" href={`/review?kind=food&id=${food.foodItemId}&after=${encodeURIComponent(back)}`}>
          Rate this dish
        </Link>
        <Link className="btn" href={`/foods/${food.foodItemId}`}>
          Open the dish<span className="sr-only"> {food.name}</span>
        </Link>
      </div>
      <p className="s13 muted" style={{ marginBottom: 0 }}>
        Your diary stays private. A rating is a separate step: it starts as a private note, and you choose whether anyone else sees it.
      </p>
    </div>
  );
}

type Props = { searchParams: Promise<RawParams> };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const DONE: Record<string, string> = {
  logged: "Added to your diary.",
  updated: "Entry updated.",
  restored: "Entry restored.",
  repeated: "Logged again.",
  repeated_updated: "Logged again. This food's information has been updated since, so the new entry uses the current numbers. Your earlier entry is unchanged.",
  repeated_copied: "Logged again with the numbers recorded last time, because this food is no longer in the catalog.",
  noted: "Saved.",
};
const PROBLEM: Record<string, string> = {
  conflict: "That entry was changed somewhere else. Nothing was removed. Please try again.",
  undo_expired: "It's too late to undo that. You can log it again.",
  portion_changed: "This food's portions have changed, so it couldn't be repeated automatically. Open the food and log it again.",
  missing: "We couldn't find that entry. It may have been removed.",
  invalid: "That request wasn't valid. Nothing was changed.",
  failed: "We couldn't save that just now. Please try again.",
};
const STATUS_LABELS: Record<(typeof DAY_STATUSES)[number], string> = {
  unspecified: "Not said",
  complete: "I logged everything I ate",
  partial: "I only logged part of the day",
};

/** Where a logged real meal's figures came from, kept with the entry (docs/63). */
function MealSourceLine({ entry }: { entry: DiaryEntry }) {
  const w = mealSourceWords(entry.source!, entry.quantity);
  return (
    <details className="s13 entry-source" data-testid="entry-source" data-evidence={entry.source!.protein.evidence} data-changed={entry.source!.protein.changedByYou || entry.source!.protein.typedByYou ? "yes" : "no"}>
      <summary>{w.headline}</summary>
      <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
        {w.lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
        {entry.source!.source.url && (
          <li>
            <a href={entry.source!.source.url} target="_blank" rel="noreferrer noopener">
              The restaurant&rsquo;s own page
            </a>
          </li>
        )}
      </ul>
    </details>
  );
}

function EntryRow({ entry, date, today }: { entry: DiaryEntry; date: string; today: string }) {
  const protein = entry.nutrients.protein_g;
  const kcal = entry.nutrients.energy_kcal?.value ?? null;
  return (
    <li className="entry" data-testid="diary-entry">
      <div className="entry-main">
        <div className="name">{entry.name}</div>
        <div className="s14 muted">
          {portionText(entry.portion, entry.quantity)} · {CONTEXT_LABELS[entry.context]}
        </div>
        {entry.source && <MealSourceLine entry={entry} />}
      </div>
      <div className="entry-num">
        {protein?.value !== null && protein?.value !== undefined ? (
          protein.method === "estimated" ? (
            <span className="pro" data-testid="entry-estimate">
              <span className="per">about</span> <span className="v">{formatAmount(protein.value)}</span> <span className="u">g</span>
              <span className="sr-only"> protein, estimated</span>
              <span className="s13 muted" style={{ display: "block" }}>
                {protein.lower != null && protein.upper != null && protein.lower !== protein.upper
                  ? `Estimate: ${formatAmount(protein.lower)}–${formatAmount(protein.upper)} g`
                  : "Estimate"}
              </span>
            </span>
          ) : (
            <span className="pro">
              <span className="v">{formatAmount(protein.value)}</span> <span className="u">g</span>
              <span className="sr-only"> protein</span>
            </span>
          )
        ) : (
          <span className="s13" style={{ fontWeight: 700, color: "var(--warning-ink)" }}>Protein not known</span>
        )}
        <div className="s13 muted">{kcal !== null ? `${formatAmount(kcal)} kcal` : ""}</div>
      </div>
      <div className="entry-actions row">
        <Link className="link-btn s14" href={`/diary/edit?entry=${entry.entryId}&date=${date}`}>
          Edit<span className="sr-only"> {entry.name}</span>
        </Link>
        <form action={repeatEntryAction}>
          <input type="hidden" name="idempotencyKey" value={randomUUID()} />
          <input type="hidden" name="entryId" value={entry.entryId} />
          <input type="hidden" name="date" value={today} />
          <button className="link-btn s14 plain" type="submit">
            {date === today ? "Log again" : "Log again today"}
            <span className="sr-only"> {entry.name}</span>
          </button>
        </form>
        <form action={deleteEntryAction}>
          <input type="hidden" name="entryId" value={entry.entryId} />
          <input type="hidden" name="expectedVersion" value={entry.version} />
          <input type="hidden" name="date" value={date} />
          <button className="link-btn s14 plain" type="submit">
            Remove<span className="sr-only"> {entry.name}</span>
          </button>
        </form>
      </div>
    </li>
  );
}

/** The member's own note on how fully the day was logged. Ids are generated so a kept-alive copy of the page never shares them. */
function DayStatusForm({ date, status }: { date: string; status: DiaryDay["status"] }) {
  const uid = useId();
  return (
    <form action={setDayStatusAction} className="panel" style={{ marginTop: 24 }}>
      <input type="hidden" name="date" value={date} />
      <label htmlFor={`${uid}-status`}>Is this day fully logged? (optional)</label>
      <div className="row" style={{ flexWrap: "nowrap" }}>
        <select id={`${uid}-status`} name="status" defaultValue={status} aria-describedby={`${uid}-hint`}>
          {DAY_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <button className="btn" type="submit">
          Save
        </button>
      </div>
      <p className="s13 muted" id={`${uid}-hint`} style={{ margin: "6px 0 0" }}>
        This only decides whether the day counts toward your weekly average. Partly logged days are left out.
      </p>
    </form>
  );
}

async function Day({ searchParams }: Props) {
  const sp = await searchParams;
  const member = await getCurrentMember();
  if (!member) {
    return <SignInPanel next="/diary">Sign in to keep a private food diary. Everything you log is visible only to you.</SignInPanel>;
  }
  const clock = await memberClock();
  const date = isoDateSchema.safeParse(one(sp.date)).data ?? clock.today;
  const day = await getDiaryDay(date);
  const done = one(sp.done);
  const problem = one(sp.problem);
  const deleted = one(sp.deleted);
  const loggedFood = done === "logged" ? idSchema.safeParse(one(sp.food)).data : undefined;
  const groups = groupByMeal(day.entries);

  return (
    <>
      <DiaryTabs active="day" date={date} />
      <div className="daynav">
        <Link className="btn" href={`/diary?date=${addDays(date, -1)}`} aria-label="Previous day">
          <Icon name="back" className="" />
        </Link>
        <div style={{ textAlign: "center" }}>
          <h2 className="title-sm" data-testid="diary-date">
            {date === clock.today ? "Today" : formatDay(date)}
          </h2>
          <div className="s13 muted">{date === clock.today ? formatDay(date) : <Link className="link" href="/diary">Go to today</Link>}</div>
        </div>
        <Link className="btn" href={`/diary?date=${addDays(date, 1)}`} aria-label="Next day">
          <Icon name="next" className="" />
        </Link>
      </div>

      <div role="status" aria-live="polite">
        {done && DONE[done] && <p className="callout calm" data-testid="diary-flash">{DONE[done]}</p>}
        {problem && PROBLEM[problem] && <p className="callout" data-testid="diary-problem">{PROBLEM[problem]}</p>}
      </div>
      {loggedFood && <NextStep foodId={loggedFood} date={date} />}
      {deleted && (
        <form action={restoreEntryAction} className="callout calm row" data-testid="diary-undo">
          <input type="hidden" name="entryId" value={deleted} />
          <input type="hidden" name="date" value={date} />
          <span>Entry removed.</span>
          <button className="btn" type="submit">
            Undo
          </button>
        </form>
      )}

      <Summary day={day} />

      <p>
        <Link className="btn primary" href={`/diary/add?date=${date}`} data-testid="add-food">
          <Icon name="plus" className="" />
          Add food
        </Link>
      </p>

      {day.entries.length === 0 && (
        <div data-testid="diary-empty">
          <p className="muted" style={{ marginBottom: 8 }}>
            Nothing logged for this day. An empty day is never counted as eating nothing.
          </p>
          {/* Bug B5 (docs/68): an empty day was a dead end. These are the three ways to start one. */}
          <p className="row" data-testid="diary-empty-next">
            <Link className="btn" href={`/diary/add?date=${date}`}>
              Log something you ate
            </Link>
            <Link className="btn" href="/protein">
              Find a protein-rich meal
            </Link>
            <Link className="btn" href="/cook">
              Cook a recipe
            </Link>
          </p>
        </div>
      )}
      {groups.map((g) => (
        <section key={g.slot} aria-labelledby={`meal-${g.slot}`}>
          <h3 className="h-sec" id={`meal-${g.slot}`}>
            {MEAL_LABELS[g.slot as MealSlot] ?? g.slot}
          </h3>
          <ul className="entries">
            {g.entries.map((e) => (
              <EntryRow key={e.entryId} entry={e} date={date} today={clock.today} />
            ))}
          </ul>
        </section>
      ))}

      {date === clock.today && (
        // After the day's own entries (P2 part 2): the diary is for what you ate; ideas come below it and stream in.
        <Suspense fallback={null}>
          <IdeasPanel day={day} from="/diary" />
        </Suspense>
      )}
      {day.entries.length > 0 && <DayStatusForm date={date} status={day.status} />}
      <PrivacyNote />
    </>
  );
}

export default function DiaryPage(props: Props) {
  return (
    <AppShell active="diary" narrow>
      <h1 className="title">Food Diary</h1>
      <Suspense fallback={<Loading />}>
        <Day {...props} />
      </Suspense>
    </AppShell>
  );
}
