import { Suspense } from "react";
import { redirect } from "next/navigation";

/** Dishes share one detail page with recipes and packaged foods. */
async function Go({ params }: { params: Promise<{ id: string }> }) {
  redirect(`/foods/${encodeURIComponent((await params).id)}`);
  return null;
}
export default function DishRedirect({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={null}>
      <Go params={params} />
    </Suspense>
  );
}
