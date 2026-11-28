import { Suspense } from "react";
import { Fresh } from "@/components/freshness";
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell, Loading } from "@/components/app-shell";
import { LogForm } from "@/components/diary/log-form";
import { Icon } from "@/components/icons";
import { idSchema } from "@/contracts/catalog";
import { KIND_LABELS } from "@/lib/format";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { DiaryError, getLoggableFood } from "@/server/diary";
import { memberClock } from "@/server/diary/clock";
import { one, targetOf } from "../params";

export const metadata = { title: "Log food" };
type Props = { searchParams: Promise<RawParams> };

const CONTEXT_FOR: Record<string, string> = { dish: "restaurant", packaged: "packaged", recipe: "home", ingredient: "home", custom: "home" };

async function Log({ searchParams }: Props) {
  const sp = await searchParams;
  const foodId = idSchema.safeParse(one(sp.food));
  if (!foodId.success) redirect("/diary/add");
  const clock = await memberClock();
  const target = targetOf(sp, clock);
  const explicit = one(sp.date) || one(sp.slot) ? `&${target.query}` : "";
  const here = `/diary/log?food=${foodId.data}${explicit}`;
  // A guest signs in first and comes back to this same form. Nothing is logged for them on the way.
  const member = await getCurrentMember();
  if (!member) redirect(`/login?next=${encodeURIComponent(here)}`);

  let food;
  try {
    food = await getLoggableFood(foodId.data);
  } catch (e) {
    if (e instanceof DiaryError && e.status === 404) {
      return (
        <div className="panel" data-testid="log-missing">
          <p style={{ marginTop: 0 }}>This food is no longer available to log.</p>
          <Link className="btn primary" href={`/diary/add?${target.query}`}>
            Choose another food
          </Link>
        </div>
      );
    }
    throw e;
  }

  return (
    <>
      <p className="eyebrow">{food.usda ? "USDA FoodData Central" : food.isOwn ? "Your own food" : (KIND_LABELS[food.kind] ?? "Food")}{food.isDemo ? " · Demo" : ""}</p>
      <h1 className="title" data-testid="log-food-name">
        {food.name}
      </h1>
      {(food.venueName || food.brand) && <p className="muted" style={{ marginTop: 0 }}>{food.venueName ?? food.brand}</p>}
      {!food.isOwn && <Fresh food={food.foodItemId} block />}
      {food.usda && (
        <p className="s14 muted" data-testid="log-usda-source">
          Nutrition from USDA FoodData Central ({food.usda.dataType === "foundation" ? "Foundation Foods" : "SR Legacy"}, release {food.usda.releaseLabel}), FDC ID {food.usda.fdcId}, per 100 g. Values USDA doesn&rsquo;t give stay unknown. USDA does not say whether a food is vegetarian or vegan.
        </p>
      )}
      <LogForm
        food={food}
        idempotencyKey={randomUUID()}
        date={target.date}
        mealSlot={target.mealSlot}
        context={CONTEXT_FOR[food.kind] ?? "home"}
        here={here}
        cancelHref={food.isOwn || food.usda ? `/diary/add?${target.query}` : `/foods/${food.foodItemId}`}
      />
      <p className="s13 muted" style={{ marginTop: 24 }}>
        The numbers are saved with the entry as they are today. If this food&rsquo;s information changes later, what you logged stays the same.
      </p>
    </>
  );
}

export default function LogPage(props: Props) {
  return (
    <AppShell active="diary" narrow>
      <Link className="link-btn" href="/diary">
        <Icon name="back" />
        Food Diary
      </Link>
      <Suspense fallback={<Loading />}>
        <Log {...props} />
      </Suspense>
    </AppShell>
  );
}
