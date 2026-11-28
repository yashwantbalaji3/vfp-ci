import { Suspense } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AppShell, Loading } from "@/components/app-shell";
import { OwnFoodForm } from "@/components/diary/own-food-form";
import { Icon } from "@/components/icons";
import { idSchema } from "@/contracts/catalog";
import { getCurrentMember } from "@/server/auth/session";
import { DiaryError, getOwnFood } from "@/server/diary";
import { setOwnFoodRemovedAction } from "../../actions";

export const metadata = { title: "Change your food" };
type Props = { params: Promise<{ id: string }> };

/**
 * Change or remove one food of the member's own (docs/56). Someone else's food, a catalog food or a
 * removed one answers "not found", the same as a food that does not exist.
 */
async function Change({ params }: Props) {
  const { id: raw } = await params;
  const id = idSchema.safeParse(raw);
  if (!id.success) notFound();
  const member = await getCurrentMember();
  if (!member) redirect(`/login?next=${encodeURIComponent(`/diary/foods/${id.data}`)}`);
  const food = await getOwnFood(id.data).catch((e) => {
    if (e instanceof DiaryError && e.status === 404) return null;
    throw e;
  });
  if (!food) notFound();
  const logged = food.timesLogged;
  return (
    <>
      <h1 className="title" data-testid="own-food-name">
        {food.name}
      </h1>
      <p className="muted" style={{ marginTop: 0 }}>
        {logged === 0
          ? "Not in your diary yet."
          : `In your diary ${logged === 1 ? "once" : `${logged} times`}. ${logged === 1 ? "That entry keeps" : "Those entries keep"} the numbers ${logged === 1 ? "it was" : "they were"} logged with.`}
      </p>
      {food.editable ? (
        <OwnFoodForm food={food} />
      ) : (
        <p className="callout">This food can&rsquo;t be changed here, because it wasn&rsquo;t written down as one serving. You can still remove it from your list.</p>
      )}
      <form action={setOwnFoodRemovedAction} style={{ marginTop: 32 }}>
        <input type="hidden" name="foodItemId" value={food.foodItemId} />
        <input type="hidden" name="remove" value="true" />
        <button className="btn" type="submit">
          Remove from your foods
        </button>
        <p className="s13 muted" style={{ margin: "6px 0 0" }}>
          It leaves your list and can&rsquo;t be logged from there any more. Your diary entries stay as they are, and you can undo this.
        </p>
      </form>
    </>
  );
}

export default function ChangePage(props: Props) {
  return (
    <AppShell active="diary" narrow>
      <Link className="link-btn" href="/diary/foods">
        <Icon name="back" />
        Your own foods
      </Link>
      <Suspense fallback={<Loading />}>
        <Change {...props} />
      </Suspense>
    </AppShell>
  );
}
