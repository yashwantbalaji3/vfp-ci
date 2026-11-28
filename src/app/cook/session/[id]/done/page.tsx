import { Suspense } from "react";
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AppShell, Loading } from "@/components/app-shell";
import { AteForm } from "@/components/cook/ate-form";
import { PrivacyNote } from "@/components/diary/diary-tabs";
import { idSchema } from "@/contracts/catalog";
import { MEAL_LABELS, MEAL_SLOTS, type MealSlot } from "@/contracts/diary";
import { weekDates } from "@/domain/dates/week";
import { defaultMealSlot } from "@/domain/diary/summary";
import { displayName, formatServings } from "@/domain/recipes/quantity";
import { formatAmount, formatDay } from "@/lib/format";
import { getCurrentMember } from "@/server/auth/session";
import { DiaryError, getDiaryWeek } from "@/server/diary";
import { memberClock } from "@/server/diary/clock";
import { getCookSession } from "@/server/recipes";

export const metadata = { title: "Cooked" };
type Props = { params: Promise<{ id: string }> };

async function Done({ params }: Props) {
  const { id: rawId } = await params;
  const id = idSchema.safeParse(rawId);
  if (!id.success) notFound();
  const member = await getCurrentMember();
  if (!member) redirect(`/login?next=${encodeURIComponent(`/cook/session/${id.data}/done`)}`);
  let session;
  try {
    session = await getCookSession(id.data);
  } catch (e) {
    if (e instanceof DiaryError && e.status === 404) notFound();
    throw e;
  }
  if (!session.completedAt) redirect(`/cook/session/${session.sessionId}`);
  const clock = await memberClock();
  const recipe = session.recipe;
  const name = displayName(recipe.name);
  const left = Math.max(0, Math.round((session.servings - session.loggedServings) * 1000) / 1000);
  const logged = session.entries.length > 0;
  const slot: MealSlot =
    recipe.mealTypes.length === 1 && (MEAL_SLOTS as readonly string[]).includes(recipe.mealTypes[0]) ? (recipe.mealTypes[0] as MealSlot) : defaultMealSlot(clock.hour);

  // The weekly home-cooking goal, if the member set one. Cooking counts toward it; eating is separate.
  let goalLine: string | null = null;
  try {
    const week = await getDiaryWeek(weekDates(session.date)[0]);
    if (week.homeMealsTarget !== null) {
      const count = week.days.reduce((n, d) => n + d.homeMeals, 0);
      goalLine = `That is ${count} of ${formatAmount(week.homeMealsTarget)} home-cooked meals for the week of ${formatDay(week.start, "short")}.`;
    }
  } catch {
    goalLine = null;
  }

  return (
    <>
      <p className="eyebrow">Cooked {session.date === clock.today ? "today" : formatDay(session.date, "short")}</p>
      <h1 className="title" data-testid="done-title">
        {name} is ready
      </h1>
      <p className="lede" data-testid="done-summary">
        You cooked {formatServings(session.servings)}
        {recipe.swapped ? " with your swaps" : ""}. This counts as home cooking. {goalLine}
      </p>
      <p className="callout calm" data-testid="done-not-logged">
        <strong>Cooking is not the same as eating.</strong>{" "}
        {logged
          ? "Only the amounts listed below are in your diary. Finishing the recipe added nothing by itself."
          : "Nothing has been added to your diary, and your protein and calories have not changed. Add what you actually ate, or choose “Not now”."}
      </p>

      {logged && (
        <section className="panel" aria-labelledby="in-diary-h" data-testid="done-logged">
          <h2 className="h-sec" id="in-diary-h" style={{ marginTop: 0 }}>
            In your diary from this batch
          </h2>
          <ul style={{ paddingLeft: 20, margin: 0 }}>
            {session.entries.map((e) => (
              <li key={e.entryId}>
                {formatServings(e.servings)} at {(MEAL_LABELS[e.mealSlot as MealSlot] ?? e.mealSlot).toLowerCase()},{" "}
                <Link className="link" href={`/diary?date=${e.date}`}>
                  {formatDay(e.date, "short")}
                </Link>
                {e.proteinG !== null ? ` · ${formatAmount(e.proteinG)} g protein` : " · protein not known"}
              </li>
            ))}
          </ul>
        </section>
      )}

      {left > 0 ? (
        <section className="panel" aria-labelledby="ate-h">
          <h2 className="h-sec" id="ate-h" style={{ marginTop: 0 }}>
            {logged ? "Log more from this batch" : "Add it to your diary?"}
          </h2>
          {logged && (
            <p className="s14 muted" style={{ marginTop: 0 }}>
              {formatServings(left)} of this batch {left === 1 ? "is" : "are"} not logged. Use this for leftovers you eat later. It will not count as cooking again.
            </p>
          )}
          <AteForm
            sessionId={session.sessionId}
            idempotencyKey={randomUUID()}
            date={clock.today}
            mealSlot={slot}
            left={left}
            proteinPerServing={recipe.nutrients.protein_g?.value ?? null}
            kcalPerServing={recipe.nutrients.energy_kcal?.value ?? null}
            additional={logged}
            showNotNow={!logged}
          />
        </section>
      ) : (
        <p className="callout calm" data-testid="done-all-logged">
          Every serving of this batch is in your diary.
        </p>
      )}

      <p className="row" style={{ marginTop: 16 }}>
        <Link className="link-btn" href="/cook">
          Back to recipes
        </Link>
        <Link className="link-btn" href="/diary/week">
          See your week
        </Link>
      </p>
      <PrivacyNote />
    </>
  );
}

export default function Page(props: Props) {
  return (
    <AppShell active="cook" narrow>
      <Suspense fallback={<Loading />}>
        <Done {...props} />
      </Suspense>
    </AppShell>
  );
}
