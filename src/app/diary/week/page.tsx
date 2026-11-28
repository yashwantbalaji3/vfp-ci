import { Suspense } from "react";
import Link from "next/link";
import { AppShell, Loading } from "@/components/app-shell";
import { DiaryTabs, PrivacyNote, SignInPanel } from "@/components/diary/diary-tabs";
import { Icon } from "@/components/icons";
import { isoDateSchema, type WeekDay } from "@/contracts/diary";
import { addDays, weekDates } from "@/domain/dates/week";
import { summarizeWeek } from "@/domain/diary/summary";
import { formatAmount, formatDay } from "@/lib/format";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { getDiaryWeek } from "@/server/diary";
import { memberClock } from "@/server/diary/clock";
import { one } from "../params";

export const metadata = { title: "Your week" };
type Props = { searchParams: Promise<RawParams> };
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function DayRow({ day, today, scaleMax }: { day: WeekDay; today: string; scaleMax: number }) {
  const logged = day.entryCount > 0;
  const pct = day.proteinKnown !== null ? Math.max(2, Math.round((day.proteinKnown / scaleMax) * 100)) : 0;
  const targetPct = day.proteinTarget !== null ? Math.min(100, Math.round((day.proteinTarget / scaleMax) * 100)) : null;
  const met = day.proteinTarget !== null && day.proteinKnown !== null && day.proteinKnown >= day.proteinTarget;
  let words: string;
  if (!logged) words = day.date > today ? "Not yet" : "Nothing logged";
  else if (day.proteinKnown === null) words = "Protein not known";
  else words = `${day.proteinUnknownEntries > 0 ? "At least " : ""}${formatAmount(day.proteinKnown)} g`;
  const notes = [
    met ? "goal reached" : null,
    logged && day.proteinUnknownEntries > 0 ? `${plural(day.proteinUnknownEntries, "item")} without protein` : null,
    logged && day.status === "partial" ? "partly logged" : null,
    day.cookSessions > 0 ? `cooked ${plural(day.cookSessions, "recipe")}` : null,
    day.plannedCount > 0 ? `${plural(day.plannedCount, "recipe")} planned (not counted)` : null,
  ].filter(Boolean);
  return (
    <li className="weekday" data-testid="week-day">
      <Link className="link" href={`/diary?date=${day.date}`}>
        {day.date === today ? "Today" : formatDay(day.date, "short")}
      </Link>
      <div className="bar" aria-hidden="true">
        {pct > 0 && <span className={met ? "fill met" : "fill"} style={{ width: `${pct}%` }} />}
        {targetPct !== null && <span className="tick" style={{ left: `${targetPct}%` }} />}
      </div>
      <div className="val">
        <strong>{words}</strong>
        {day.proteinTarget !== null && <span className="muted"> · goal {formatAmount(day.proteinTarget)} g</span>}
        {notes.length > 0 && <span className="muted"> · {notes.join(", ")}</span>}
      </div>
    </li>
  );
}

async function Week({ searchParams }: Props) {
  const sp = await searchParams;
  const member = await getCurrentMember();
  if (!member) return <SignInPanel next="/diary/week">Sign in to see your week. Your diary is visible only to you.</SignInPanel>;
  const clock = await memberClock();
  const date = isoDateSchema.safeParse(one(sp.date)).data ?? clock.today;
  const dates = weekDates(date);
  const week = await getDiaryWeek(dates[0]);
  const s = summarizeWeek(week.days, clock.today);
  const isThisWeek = dates.includes(clock.today);
  const hasGoal = week.days.some((d) => d.proteinTarget !== null);

  return (
    <>
      <DiaryTabs active="week" date={date} />
      <div className="daynav">
        <Link className="btn" href={`/diary/week?date=${addDays(dates[0], -7)}`} aria-label="Previous week">
          <Icon name="back" className="" />
        </Link>
        <div style={{ textAlign: "center" }}>
          <h2 className="title-sm" data-testid="week-range">
            {isThisWeek ? "This week" : `Week of ${formatDay(dates[0], "short")}`}
          </h2>
          <div className="s13 muted">
            {formatDay(dates[0], "short")} to {formatDay(dates[6], "short")}
          </div>
        </div>
        <Link className="btn" href={`/diary/week?date=${addDays(dates[0], 7)}`} aria-label="Next week">
          <Icon name="next" className="" />
        </Link>
      </div>

      <ul className="facts two" aria-label="Week summary" data-testid="week-summary">
        <li data-testid="week-total">
          <div className="k">Protein logged</div>
          {s.totalKnownProtein !== null ? (
            <div className="big">
              {s.incompleteDays > 0 && <span className="s13 muted">at least </span>}
              {formatAmount(s.totalKnownProtein)} g
            </div>
          ) : (
            <div className="big words">{s.loggedDays > 0 ? "Not known" : "Nothing logged"}</div>
          )}
          <div className="s13 muted">Known total for the week</div>
        </li>
        <li data-testid="week-average">
          <div className="k">Daily average</div>
          {s.averageProtein !== null ? <div className="big">{formatAmount(s.averageProtein)} g</div> : <div className="big words">Not enough logged</div>}
          <div className="s13 muted">{s.averageProtein !== null ? `Across ${plural(s.averageDays, "fully logged day")}` : "Needs one fully logged day"}</div>
        </li>
        <li data-testid="week-goal-days">
          <div className="k">Protein goal reached</div>
          {hasGoal ? (
            <>
              <div className="big">
                {s.daysTargetMet} of {plural(s.daysWithTarget, "day")}
              </div>
              <div className="s13 muted">{[
                  s.daysTargetMetWithEstimates > 0 ? `${s.daysTargetMetWithEstimates} of them ${s.daysTargetMetWithEstimates === 1 ? "is" : "are"} based on estimates` : null,
                  s.daysTargetUnclear > 0 ? `${plural(s.daysTargetUnclear, "more day")} can't be told from what's logged` : null,
                ]
                  .filter(Boolean)
                  .join(". ") || "Days so far that had a goal"}</div>
            </>
          ) : (
            <>
              <div className="big words">No goal set</div>
              <div className="s13">
                <Link className="link" href="/diary/goals">
                  Goals are optional
                </Link>
              </div>
            </>
          )}
        </li>
        <li data-testid="week-home">
          <div className="k">Home-cooked meals</div>
          <div className="big">
            {s.homeMeals}
            {week.homeMealsTarget !== null && <span className="s14 muted"> of your {formatAmount(week.homeMealsTarget)}</span>}
          </div>
          <div className="s13 muted">
            {s.cookSessions > 0
              ? `${plural(s.cookSessions, "finished cooking session")} and meals logged as home-cooked. The same meal is counted once.`
              : "Finished cooking sessions and meals logged as home-cooked"}
          </div>
        </li>
      </ul>

      <section aria-labelledby="cov-h" className="panel" data-testid="week-coverage">
        <h3 className="h-sec" id="cov-h" style={{ marginTop: 0 }}>
          What these numbers are based on
        </h3>
        <ul className="s14" style={{ paddingLeft: 20, margin: 0 }}>
          <li>You logged food on {s.loggedDays} of 7 days.</li>
          {s.incompleteDays > 0 && (
            <li>
              {plural(s.incompleteDays, "day")} {s.incompleteDays === 1 ? "has" : "have"} items without a protein value. Those items are left out of the totals, so the real amount is the same or higher.
            </li>
          )}
          {s.partialDays > 0 && <li>You marked {plural(s.partialDays, "day")} as only partly logged.</li>}
          <li>
            The daily average uses only days where you logged food, every item has a protein value, and you didn&rsquo;t mark the day as partly logged
            {s.averageDays > 0 ? ` (${plural(s.averageDays, "day")} this week)` : ""}. Days with nothing logged are left out. They are never counted as zero.
          </li>
        </ul>
      </section>

      <section aria-labelledby="days-h">
        <h3 className="h-sec" id="days-h">
          Protein day by day
        </h3>
        <ul className="weekdays">
          {week.days.map((d) => (
            <DayRow key={d.date} day={d} today={clock.today} scaleMax={s.scaleMax} />
          ))}
        </ul>
        {hasGoal && <p className="s13 muted">The small line on each bar marks your goal for that day.</p>}
        {s.planned > 0 && (
          <p className="s13 muted" data-testid="week-planned">
            Planned recipes are shown as a reminder only. They add nothing to protein, calories or the home-cooking count.{" "}
            <Link className="link" href="/cook/plan">
              See your plan
            </Link>
          </p>
        )}
      </section>
      <PrivacyNote />
    </>
  );
}

export default function WeekPage(props: Props) {
  return (
    <AppShell active="diary" narrow>
      <h1 className="title">Food Diary</h1>
      <Suspense fallback={<Loading />}>
        <Week {...props} />
      </Suspense>
    </AppShell>
  );
}
