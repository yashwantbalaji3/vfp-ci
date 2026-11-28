import Link from "next/link";
import { addToListAction, saveListAction } from "@/app/social/actions";
import type { TargetKind } from "@/contracts/social";
import { getCurrentMember } from "@/server/auth/session";
import { getMyLists } from "@/server/social";

/** Put a place, dish or recipe on one of your own lists, or start a new list with it. */
export async function AddToList({ kind, id, returnTo }: { kind: TargetKind; id: string; returnTo: string }) {
  const member = await getCurrentMember();
  let lists: Awaited<ReturnType<typeof getMyLists>> = [];
  if (member) {
    try {
      lists = await getMyLists();
    } catch {
      return null;
    }
  }
  return (
    <details className="sheet" style={{ marginTop: 12 }} data-testid="add-to-list">
      <summary>Add to a list</summary>
      <div className="sheet-body stack">
        {!member ? (
          <p style={{ margin: 0 }}>
            <Link className="link" href={`/login?next=${encodeURIComponent(returnTo)}`}>
              Sign in to keep lists
            </Link>
            . Lists are private until you choose to publish one.
          </p>
        ) : (
          <>
            {lists.length > 0 && (
              <form action={addToListAction} className="stack">
                <input type="hidden" name="return" value={returnTo} />
                <input type="hidden" name="kind" value={kind} />
                <input type="hidden" name="targetId" value={id} />
                <div>
                  <label htmlFor="atl-list">Choose one of your lists</label>
                  <select id="atl-list" name="listId">
                    {lists.map((l) => (
                      <option key={l.listId} value={l.listId}>
                        {l.title} ({l.visibility === "public" ? "public" : "private"})
                      </option>
                    ))}
                  </select>
                </div>
                <button className="btn primary" type="submit">
                  Add to this list
                </button>
              </form>
            )}
            <form action={saveListAction} className="stack">
              <input type="hidden" name="return" value={returnTo} />
              <input type="hidden" name="kind" value={kind} />
              <input type="hidden" name="targetId" value={id} />
              <div>
                <label htmlFor="atl-new">{lists.length > 0 ? "Or start a new list" : "Start your first list"}</label>
                <input id="atl-new" type="text" name="title" maxLength={80} required placeholder="For example: Weeknight favourites" />
              </div>
              <button className="btn" type="submit">
                Create list and add this
              </button>
              <p className="s13 muted" style={{ margin: 0 }}>
                A new list is private. Only you can see it until you publish it.
              </p>
            </form>
          </>
        )}
      </div>
    </details>
  );
}
