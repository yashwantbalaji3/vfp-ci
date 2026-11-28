import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell, Loading } from "@/components/app-shell";
import { Icon } from "@/components/icons";
import { idSchema } from "@/contracts/catalog";
import { formatAmount } from "@/lib/format";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { getCustomFoods } from "@/server/diary";
import { setOwnFoodRemovedAction } from "../actions";
import { one } from "../params";

export const metadata = { title: "Your own foods" };
type Props = { searchParams: Promise<RawParams> };

const PROBLEM: Record<string, string> = {
  missing: "We couldn't find that food. It may already have been removed.",
  invalid: "That request wasn't valid. Nothing was changed.",
  failed: "We couldn't save that just now. Please try again.",
};

/**
 * The member's own foods, with Change and Remove (docs/56). Private to the member: the list is read as
 * them, and nobody else's foods can appear. Changing or removing a food never alters diary entries.
 */
async function Foods({ searchParams }: Props) {
  const sp = await searchParams;
  const member = await getCurrentMember();
  if (!member) redirect(`/login?next=${encodeURIComponent("/diary/foods")}`);
  const foods = await getCustomFoods();
  const done = one(sp.done);
  const food = idSchema.safeParse(one(sp.food));
  const problem = one(sp.problem);
  const changed = food.success ? foods.find((f) => f.foodItemId === food.data) : undefined;

  return (
    <>
      <div role="status" aria-live="polite">
        {done === "changed" && changed && (
          <p className="callout calm" data-testid="own-flash">
            Saved. {changed.name} now uses your changes. Entries already in your diary keep the numbers they were logged with.
          </p>
        )}
        {done === "restored" && (
          <p className="callout calm" data-testid="own-flash">
            Put back on your list.
          </p>
        )}
        {done === "removed" && food.success && (
          <div className="callout calm" data-testid="own-flash">
            <p style={{ margin: 0 }}>Removed from your list. Entries already in your diary are unchanged.</p>
            <form action={setOwnFoodRemovedAction} style={{ marginTop: 8 }}>
              <input type="hidden" name="foodItemId" value={food.data} />
              <input type="hidden" name="remove" value="false" />
              <button className="btn small" type="submit">
                Undo
              </button>
            </form>
          </div>
        )}
        {problem && PROBLEM[problem] && (
          <p className="callout" data-testid="own-problem">
            {PROBLEM[problem]}
          </p>
        )}
      </div>

      {foods.length === 0 ? (
        <div className="panel" data-testid="own-empty">
          <p style={{ marginTop: 0 }}>You haven&rsquo;t written down any foods of your own yet.</p>
          <Link className="btn primary" href="/diary/custom">
            Write down a food
          </Link>
        </div>
      ) : (
        <ul className="entries" data-testid="own-foods">
          {foods.map((f) => (
            <li key={f.foodItemId} className="entry">
              <div className="entry-main">
                <div className="name">{f.name}</div>
                <div className="s14 muted">
                  {[f.brand, f.proteinG !== null ? `${formatAmount(f.proteinG)} g protein per serving` : "Protein not known"].filter(Boolean).join(" · ")}
                </div>
              </div>
              <div className="row">
                <Link className="btn small" href={`/diary/foods/${f.foodItemId}`}>
                  Change<span className="sr-only"> {f.name}</span>
                </Link>
                <Link className="btn small" href={`/diary/log?food=${f.foodItemId}`}>
                  Log it<span className="sr-only"> {f.name}</span>
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="s13 muted" style={{ marginTop: 16 }}>
        Only you can see these. Changing or removing a food never changes what is already in your diary.
      </p>
    </>
  );
}

export default function FoodsPage(props: Props) {
  return (
    <AppShell active="diary" narrow>
      <Link className="link-btn" href="/diary/add">
        <Icon name="back" />
        Add food
      </Link>
      <h1 className="title">Your own foods</h1>
      <Suspense fallback={<Loading />}>
        <Foods {...props} />
      </Suspense>
    </AppShell>
  );
}
