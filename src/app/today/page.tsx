import { Suspense } from "react";
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { AppShell, Loading } from "@/components/app-shell";
import { DiaryTabs, PrivacyNote } from "@/components/diary/diary-tabs";
import { IdeasPanel, Summary, TodayPlan } from "@/components/diary/day-panels";
import { Icon } from "@/components/icons";
import { weekDates } from "@/domain/dates/week";
import { summarizeWeek } from "@/domain/diary/summary";
import { formatAmount, formatDay } from "@/lib/format";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { getDiaryDay, getDiaryWeek, getRecentFoods } from "@/server/diary";
import { memberClock } from "@/server/diary/clock";
import { repeatEntryAction } from "../diary/actions";
import { one } from "../diary/params";

export const metadata = { title: "Today" };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const DONE: Record<string, string> = {
  repeated: "Logged again.",
  repeated_updated: "Logged again. This food's information has been updated since, so the new entry uses the current numbers. Your earlier entry is unchanged.",
  repeated_copied: "Logged again with the numbers recorded last time, because this food is no longer in the catalog.",
};
const PROBLEM: Record<string, string> = {
  portion_changed: "This food's portions have changed, so it couldn't be logged again automatically. Open it from your diary and log it again.",
  missing: "We couldn't find that entry. It may have been removed.",
  invalid: "That request wasn't valid. Nothing was changed.",
  failed: "We couldn't save that just now. Please try again.",
};

/**
 * Today (docs/68, launch blocker L1): one screen for the day. What you've logged against your goal, ideas for
 * the next meal that fit your diet and say where their protein figure came from, a quick way to log a recent
 * food again, and the week so far. It reads the same records as the diary and the week view, so the three agree.
 * Everything here is private to the person; nothing is posted or shared.
 */
async function Day({ searchParams }: { searchParams: Promise<RawParams> }) {
  const sp = await searchParams;
  const member = await getCurrentMember();
  if (!member) return <Welcome />;
  const clock = await memberClock();
  const today = clock.today;
  const dates = weekDates(today);
  const [day, week, recent] = await Promise.all([getDiaryDay(today), getDiaryWeek(dates[0]), getRecentFoods(8).catch(() => [])]);
  const s = summarizeWeek(week.days, today);
  const hasGoal = week.days.some((d) => d.proteinTarget !== null);
  const loggedToday = new Set(day.entries.map((e) => e.name));
  const again = recent.filter((r) => r.lastDate < today && !loggedToday.has(r.name)).slice(0, 3);
  const done = one(sp.done);
  const problem = one(sp.problem);

  return (
    <>
      <DiaryTabs active="today" />
      <p className="s14 muted" style={{ margin: "0 0 12px" }} data-testid="today-date">
        {formatDay(today)}
      </p>
      <div role="status" aria-live="polite">
        {done && DONE[done] && <p className="callout calm" data-testid="today-flash">{DONE[done]}</p>}
        {problem && PROBLEM[problem] && <p className="callout" data-testid="today-problem">{PROBLEM[problem]}</p>}
      </div>

      {/* With nothing logged and no goal, the summary only repeated "nothing yet" (overnight directive, part 3.4). */}
      {(day.entries.length > 0 || day.proteinTarget != null) && <Summary day={day} />}

      <section aria-labelledby="logged-h" style={{ marginTop: 16 }} data-testid="today-logged">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
          <h2 className="h-sec" id="logged-h" style={{ margin: 0 }}>
            {day.entries.length === 0 ? "Nothing logged yet today" : `Logged today (${day.entries.length})`}
          </h2>
          {day.entries.length > 0 && (
            <Link className="link s14" href="/diary">
              Open the diary
            </Link>
          )}
        </div>
        {day.entries.length > 0 && (
          <ul className="entries">
            {day.entries.map((e) => {
              const p = e.nutrients.protein_g;
              return (
                <li key={e.entryId} className="entry" data-testid="today-entry">
                  <span>{e.name}</span>
                  <span className="pro s14">
                    {p?.value == null ? "Protein not known" : `${p.method === "estimated" ? "about " : ""}${formatAmount(p.value)} g`}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <p style={{ margin: "12px 0 0" }}>
          <Link className="btn primary" href={`/diary/add?date=${today}`} data-testid="today-add">
            <Icon name="plus" className="" />
            Log food
          </Link>
        </p>
      </section>

      <Suspense fallback={null}>
        <TodayPlan today={today} />
      </Suspense>

      <div style={{ marginTop: 16 }}>
        <Suspense fallback={null}>
          <IdeasPanel day={day} from="/today" />
        </Suspense>
      </div>

      {again.length > 0 && (
        <section aria-labelledby="again-h" style={{ marginTop: 16 }} data-testid="today-again">
          <h2 className="h-sec" id="again-h">
            Log again
          </h2>
          <ul className="entries">
            {again.map((r) => (
              <li key={r.entryId} className="entry">
                <div>
                  <span>{r.name}</span>
                  <div className="s13 muted">Last logged {formatDay(r.lastDate, "short")}</div>
                </div>
                <form action={repeatEntryAction}>
                  <input type="hidden" name="idempotencyKey" value={randomUUID()} />
                  <input type="hidden" name="entryId" value={r.entryId} />
                  <input type="hidden" name="date" value={today} />
                  <input type="hidden" name="back" value="today" />
                  <button className="btn" type="submit" data-testid="today-again-log">
                    Log again<span className="sr-only"> {r.name}</span>
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel" aria-labelledby="week-h" style={{ marginTop: 16 }} data-testid="today-week">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
          <h2 className="title-sm" id="week-h" style={{ margin: 0 }}>
            This week
          </h2>
          <Link className="link s14" href="/diary/week">
            See the week
          </Link>
        </div>
        <ul className="facts two" style={{ marginTop: 8 }}>
          <li data-testid="today-week-goal">
            <div className="k">Protein goal reached</div>
            {hasGoal ? (
              <div className="big">
                {s.daysTargetMet} of {plural(s.daysWithTarget, "day")}
              </div>
            ) : (
              <div className="big words">No goal set</div>
            )}
            {hasGoal && s.daysTargetMetWithEstimates > 0 && <div className="s13 muted">{s.daysTargetMetWithEstimates} based on estimates</div>}
          </li>
          <li data-testid="today-week-home">
            <div className="k">Home-cooked meals</div>
            <div className="big">
              {s.homeMeals}
              {week.homeMealsTarget !== null && <span className="s14 muted"> of your {formatAmount(week.homeMealsTarget)}</span>}
            </div>
            {s.planned > 0 && <div className="s13 muted">{plural(s.planned, "recipe")} planned</div>}
          </li>
        </ul>
        {!hasGoal && week.homeMealsTarget === null && (
          <p className="s14 muted" style={{ margin: "8px 0 0" }}>
            <Link className="link" href="/diary/goals">
              Set a daily protein or weekly cooking goal
            </Link>{" "}
            if you like. Goals are optional.
          </p>
        )}
      </section>

      <PrivacyNote />
    </>
  );
}

/** A visitor: what Today is, and the two ways in. Nothing personal is shown or stored. */
function Welcome() {
  return (
    <div className="panel" data-testid="today-welcome">
      <p style={{ marginTop: 0 }}>
        Today brings your day together: what you&rsquo;ve eaten, protein against a goal you choose, and ideas for your next meal that fit your diet.
        Your diary is private to you.
      </p>
      <div className="row">
        <Link className="btn primary" href="/login?next=%2Ftoday">
          Sign in
        </Link>
        <Link className="btn" href="/discover">
          Explore food first
        </Link>
      </div>
    </div>
  );
}

export default function TodayPage(props: { searchParams: Promise<RawParams> }) {
  return (
    <AppShell active="today" narrow>
      <h1 className="title">Today</h1>
      <Suspense fallback={<Loading />}>
        <Day {...props} />
      </Suspense>
    </AppShell>
  );
}
