import { Suspense } from "react";
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell, Loading } from "@/components/app-shell";
import { CustomFoodForm } from "@/components/diary/custom-food-form";
import { Icon } from "@/components/icons";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { memberClock } from "@/server/diary/clock";
import { idSchema } from "@/contracts/catalog";
import { mealDiaryPrefill, type MealDiaryPrefill } from "@/contracts/meal-diary";
import { getPreviewAudience, getPreviewMeal } from "@/server/catalog/menu-preview";
import { getDiaryDay } from "@/server/diary";
import { targetOf } from "../params";

export const metadata = { title: "Your own food" };
type Props = { searchParams: Promise<RawParams> };

async function Custom({ searchParams }: Props) {
  const sp = await searchParams;
  const clock = await memberClock();
  const target = targetOf(sp, clock);
  const mealId = idSchema.safeParse(Array.isArray(sp.meal) ? sp.meal[0] : sp.meal).data;
  const here = `/diary/custom?${target.query}${mealId ? `&meal=${mealId}` : ""}`;
  const member = await getCurrentMember();
  if (!member) redirect(`/login?next=${encodeURIComponent(here)}`);
  // "Log this meal" from a real meal page (the founder, or a member of the local member beta; anyone else gets the
  // empty form). The figures shown are the ones that person may see; the server reads them again when logging.
  let prefill: MealDiaryPrefill | null = null;
  let already = 0;
  if (mealId && (await getPreviewAudience()) !== null) {
    const found = await getPreviewMeal(mealId);
    if (found?.meal) {
      prefill = mealDiaryPrefill(found.meal, found.place.name);
      // Logging the same meal twice on one day is allowed (two burritos happen) but never silent.
      const day = await getDiaryDay(target.date).catch(() => null);
      already = day?.entries.filter((e) => e.source?.dish.id === mealId).length ?? 0;
    }
  }
  return (
    <>
    {already > 0 && (
      <p className="callout" role="note" data-testid="custom-already-logged">
        <strong>Already in your diary.</strong> You logged this meal {already === 1 ? "once" : `${already} times`} on this day. Adding it again makes another entry.{" "}
        <Link href={`/diary?date=${target.date}`}>See the day</Link>
      </p>
    )}
    <CustomFoodForm
      idempotencyKey={randomUUID()}
      date={target.date}
      mealSlot={target.mealSlot}
      here={here}
      cancelHref={mealId && prefill ? `/meals/${mealId}` : `/diary/add?${target.query}`}
      prefill={prefill?.values}
      note={prefill?.note}
      mealId={prefill ? mealId : undefined}
    />
    </>
  );
}

export default function CustomPage(props: Props) {
  return (
    <AppShell active="diary" narrow>
      <Link className="link-btn" href="/diary">
        <Icon name="back" />
        Food Diary
      </Link>
      <h1 className="title">Write down your own food</h1>
      <p className="muted">A home-cooked meal, a packaged product, or anything that isn&rsquo;t in the catalog.</p>
      <Suspense fallback={<Loading />}>
        <Custom {...props} />
      </Suspense>
    </AppShell>
  );
}
