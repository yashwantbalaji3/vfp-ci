import { Suspense } from "react";
import { AppShell, Loading } from "@/components/app-shell";
import { saveListAction } from "@/app/social/actions";
import { Flash, ListCard, SignInPrompt, SocialNav } from "@/components/social/bits";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { getMyLists, getMyProfile } from "@/server/social";

export const metadata = { title: "My lists" };

async function Lists({ searchParams }: { searchParams: Promise<RawParams> }) {
  const sp = await searchParams;
  const member = await getCurrentMember();
  if (!member) {
    return (
      <SignInPrompt next="/friends/lists">
        <p>Sign in to make lists of places, dishes and recipes.</p>
      </SignInPrompt>
    );
  }
  const [me, lists] = await Promise.all([getMyProfile(), getMyLists()]);
  return (
    <>
      <SocialNav active="lists" requests={me.incomingRequests} />
      <Flash sp={sp} />
      <p className="s14 muted">Ordered collections of restaurants, dishes and recipes. A list is private until you publish it. Your own foods and diary entries can never be put on a list.</p>
      {lists.length === 0 ? (
        <div className="empty" data-testid="lists-empty">
          <h2>No lists yet</h2>
          <p>Start one below, or open any dish, recipe or place and choose &ldquo;Add to a list&rdquo;.</p>
        </div>
      ) : (
        <ul className="feed" data-testid="my-lists">
          {lists.map((l) => (
            <ListCard key={l.listId} list={l} href={`/friends/lists/${l.listId}`} />
          ))}
        </ul>
      )}
      <form action={saveListAction} className="panel stack" data-testid="new-list-form">
        <input type="hidden" name="return" value="/friends/lists" />
        <h2 className="h-sec" style={{ marginTop: 0 }}>
          Start a new list
        </h2>
        <div>
          <label htmlFor="nl-title">Title</label>
          <input id="nl-title" type="text" name="title" maxLength={80} required />
        </div>
        <div>
          <label htmlFor="nl-desc">What is it for? (optional)</label>
          <textarea id="nl-desc" name="description" maxLength={500} rows={2} />
        </div>
        <button className="btn primary" type="submit">
          Create private list
        </button>
      </form>
    </>
  );
}

export default function Page({ searchParams }: { searchParams: Promise<RawParams> }) {
  return (
    <AppShell active="friends" narrow>
      <h1 className="title">My lists</h1>
      <Suspense fallback={<Loading />}>
        <Lists searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}
