import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import { Loading } from "@/components/app-shell";
import { CookMode } from "@/components/cook/cook-mode";
import { idSchema } from "@/contracts/catalog";
import { displayName } from "@/domain/recipes/quantity";
import { getCurrentMember } from "@/server/auth/session";
import { DiaryError } from "@/server/diary";
import { getCookSession } from "@/server/recipes";

export const metadata = { title: "Cooking" };
type Props = { params: Promise<{ id: string }> };

/** Cook mode has no tabs or side menu on purpose: one step, two buttons, nothing else competing for attention. */
async function Session({ params }: Props) {
  const { id: rawId } = await params;
  const id = idSchema.safeParse(rawId);
  if (!id.success) notFound();
  const member = await getCurrentMember();
  if (!member) redirect(`/login?next=${encodeURIComponent(`/cook/session/${id.data}`)}`);
  let session;
  try {
    session = await getCookSession(id.data);
  } catch (e) {
    // Someone else's session and a session that never existed look exactly the same.
    if (e instanceof DiaryError && e.status === 404) notFound();
    throw e;
  }
  if (session.completedAt) redirect(`/cook/session/${session.sessionId}/done`);
  if (session.abandonedAt) redirect(`/cook/${session.recipe.foodItemId}`);
  const recipe = session.recipe;
  return (
    <CookMode
      sessionId={session.sessionId}
      recipeId={recipe.foodItemId}
      name={displayName(recipe.name)}
      servings={session.servings}
      ingredients={recipe.ingredients
        .filter((i) => i.included)
        .map((i) => ({ id: i.id, name: i.name, quantity: i.quantity, unit: i.unit, prepNote: i.prepNote, optional: i.optional, swappedIn: i.group !== null && !i.isDefault }))}
      equipment={recipe.equipment}
      steps={recipe.steps}
      initialStep={session.currentStep}
      initialChecked={session.checkedIngredients}
    />
  );
}

export default function Page(props: Props) {
  return (
    <Suspense fallback={<div className="cook-body"><Loading label="Opening your cooking session…" /></div>}>
      <Session {...props} />
    </Suspense>
  );
}
