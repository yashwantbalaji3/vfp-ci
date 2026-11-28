import { Suspense } from "react";
import Link from "next/link";
import { AppShell, Loading } from "@/components/app-shell";
import { relationshipAction } from "@/app/social/actions";
import { Flash, PersonRow, SignInPrompt, SocialNav } from "@/components/social/bits";
import { handleSchema, type Person } from "@/contracts/social";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { SocialError, findPeople, getConnections, getMyProfile } from "@/server/social";
import { limitNotice } from "@/components/too-many-requests";
import { pageLimit } from "@/server/page-limit";

export const metadata = { title: "People" };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function Group({ id, title, hint, people, empty, ops }: { id: string; title: string; hint: string; people: Person[]; empty: string; ops: { op: string; label: string; primary?: boolean }[] }) {
  return (
    <section aria-labelledby={`${id}-h`} data-testid={`group-${id}`}>
      <h2 className="h-sec" id={`${id}-h`}>
        {title} ({people.length})
      </h2>
      <p className="s14 muted" style={{ marginTop: 0 }}>
        {hint}
      </p>
      {people.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <ul className="mine-list">
          {people.map((p) => (
            <li key={p.handle}>
              <div>
                <PersonRow person={p} />
              </div>
              <form action={relationshipAction} className="inline-forms">
                <input type="hidden" name="return" value="/friends/people" />
                <input type="hidden" name="handle" value={p.handle} />
                {ops.map((o) => (
                  <button key={o.op} className={`btn small ${o.primary ? "primary" : ""}`} type="submit" name="op" value={o.op} aria-label={`${o.label}: ${p.displayName}`}>
                    {o.label}
                  </button>
                ))}
              </form>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

async function People({ searchParams }: { searchParams: Promise<RawParams> }) {
  const refused = limitNotice(await pageLimit());
  if (refused) return refused;
  const sp = await searchParams;
  const member = await getCurrentMember();
  if (!member) {
    return (
      <SignInPrompt next="/friends/people">
        <p>Sign in to find people and manage who you follow.</p>
      </SignInPrompt>
    );
  }
  const q = (one(sp.q) ?? "").trim();
  const handle = q ? handleSchema.safeParse(q) : null;
  const [me, c] = await Promise.all([getMyProfile(), getConnections()]);
  let results: Person[] = [];
  let searchNote = "";
  if (handle?.success) {
    try {
      results = await findPeople(handle.data);
    } catch (e) {
      searchNote = e instanceof SocialError && e.status === 429 ? "You've searched a lot in a short time. Please wait a minute." : "Search isn't available right now.";
    }
  } else if (q) {
    searchNote = "A handle uses 3 to 30 lowercase letters, numbers or underscores.";
  }
  return (
    <>
      <SocialNav active="people" requests={me.incomingRequests} />
      <Flash sp={sp} />
      <section aria-labelledby="find-h">
        <h2 className="h-sec" id="find-h">
          Find someone by their handle
        </h2>
        <form className="searchbar" action="/friends/people" method="get" role="search">
          <label className="sr-only" htmlFor="people-q">
            Exact handle
          </label>
          <input id="people-q" type="search" name="q" defaultValue={q} placeholder="@handle" autoComplete="off" autoCapitalize="none" maxLength={31} />
          <button className="btn primary" type="submit">
            Find
          </button>
        </form>
        <p className="s13 muted">Type the whole handle. Only people who chose to be findable appear. We never search your contacts or email.</p>
        <div role="status" aria-live="polite" data-testid="people-results">
          {searchNote && <p className="callout">{searchNote}</p>}
          {handle?.success && !searchNote && results.length === 0 && <p className="muted">No findable member has the handle @{handle.data}.</p>}
          {results.length > 0 && (
            <ul className="mine-list">
              {results.map((p) => (
                <li key={p.handle}>
                  <div>
                    <PersonRow person={p} />
                  </div>
                  <Link className="btn small" href={`/u/${p.handle}`}>
                    View profile
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {c.incoming.length > 0 && (
        <Group id="incoming" title="Friend requests" hint="Accepting lets each of you see what the other shares with friends. Nothing else." people={c.incoming} empty=""
          ops={[{ op: "accept", label: "Accept", primary: true }, { op: "decline", label: "Decline" }]} />
      )}
      <Group id="friends" title="Friends" hint="You both agreed. You see each other's friends-only posts." people={c.friends} empty="No friends yet. Open someone's profile to send a request."
        ops={[{ op: "unfriend", label: "Remove friend" }]} />
      <Group id="following" title="Following" hint="You see their public posts in your Following feed. Only you can see this list." people={c.following} empty="You're not following anyone yet."
        ops={[{ op: "unfollow", label: "Unfollow" }]} />
      <Group id="followers" title="Followers" hint="They see your public posts. Only you can see this list; others see just the number." people={c.followers} empty="No followers yet."
        ops={[{ op: "block", label: "Block" }]} />
      {c.outgoing.length > 0 && (
        <Group id="outgoing" title="Requests you sent" hint="Waiting for an answer." people={c.outgoing} empty="" ops={[{ op: "unfriend", label: "Cancel request" }]} />
      )}
      <Group id="blocked" title="Blocked" hint="You and a blocked person cannot see each other's profile or posts. They are not told." people={c.blocked} empty="You haven't blocked anyone."
        ops={[{ op: "unblock", label: "Unblock" }]} />
    </>
  );
}

export default function Page({ searchParams }: { searchParams: Promise<RawParams> }) {
  return (
    <AppShell active="friends" narrow>
      <h1 className="title">People</h1>
      <Suspense fallback={<Loading />}>
        <People searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}
