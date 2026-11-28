import { Suspense } from "react";
import { AppShell, Loading } from "@/components/app-shell";
import { newFoodAction, startChangeAction } from "@/app/editor/actions";
import { PracticeNote, StaffDenied, StaffNav } from "@/components/editor/bits";
import { Flash, SignInPrompt } from "@/components/social/bits";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { getItems, getStaffAlerts } from "@/server/editor";

export const metadata = { title: "Enter something new", robots: { index: false, follow: false } };

async function NewForms({ searchParams }: { searchParams: Promise<RawParams> }) {
  const sp = await searchParams;
  const member = await getCurrentMember();
  if (!member) {
    return (
      <SignInPrompt next="/editor/new">
        <p>Sign in to continue.</p>
      </SignInPrompt>
    );
  }
  const alerts = await getStaffAlerts();
  if (!alerts?.isEditor) return <StaffDenied what="catalog editors" />;
  const items = await getItems();
  const places = items.venues.filter((v) => v.status !== "closed");
  return (
    <>
      <StaffNav alerts={alerts} here="/editor/new" />
      <Flash sp={sp} />
      <PracticeNote />
      <p className="s14 muted">Each of these starts a draft. You then add the details and the source, and send it to a second person. Nothing is public until they have checked it.</p>

      <h2 className="h-sec">A dish at a place</h2>
      <form action={newFoodAction} className="stack panel" data-testid="new-dish">
        <input type="hidden" name="return" value="/editor/new" />
        <input type="hidden" name="kind" value="dish" />
        <div>
          <label htmlFor="nd-venue">Place</label>
          <select id="nd-venue" name="venueId" required>
            {places.map((v) => (
              <option key={v.venueId} value={v.venueId}>
                {v.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="nd-name">Name of the dish, as the place writes it</label>
          <input id="nd-name" name="name" type="text" required maxLength={200} autoComplete="off" />
        </div>
        <div>
          <label htmlFor="nd-desc">Description in your own words (optional)</label>
          <textarea id="nd-desc" name="description" rows={2} maxLength={1000} />
          <p className="s13 muted">Do not copy the menu&rsquo;s wording.</p>
        </div>
        <button className="btn primary" type="submit">
          Start the dish draft
        </button>
      </form>

      <h2 className="h-sec">A recipe</h2>
      <form action={newFoodAction} className="stack panel" data-testid="new-recipe">
        <input type="hidden" name="return" value="/editor/new" />
        <input type="hidden" name="kind" value="recipe" />
        <div>
          <label htmlFor="nr-name">Name of the recipe</label>
          <input id="nr-name" name="name" type="text" required maxLength={200} autoComplete="off" />
        </div>
        <div>
          <label htmlFor="nr-desc">Short description (optional)</label>
          <textarea id="nr-desc" name="description" rows={2} maxLength={1000} />
          <p className="s13 muted">Only our own original recipes. Never paste a recipe from a book or a website.</p>
        </div>
        <button className="btn primary" type="submit">
          Start the recipe draft
        </button>
      </form>

      <h2 className="h-sec">A place</h2>
      <form action={startChangeAction} className="stack panel" data-testid="new-place">
        <input type="hidden" name="return" value="/editor/new" />
        <input type="hidden" name="newVenue" value="1" />
        <p className="s14">You will enter its name, address and hours on the next screen, with where you saw them.</p>
        <button className="btn primary" type="submit">
          Start the place draft
        </button>
      </form>
    </>
  );
}

export default function EditorNewPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  return (
    <AppShell active="none" narrow>
      <h1 className="title">Enter something new</h1>
      <Suspense fallback={<Loading />}>
        <NewForms searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}
