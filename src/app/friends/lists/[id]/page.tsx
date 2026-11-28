import { Suspense } from "react";
import { FreshTarget } from "@/components/freshness";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AppShell, Loading } from "@/components/app-shell";
import { listItemAction, listStateAction, saveListAction } from "@/app/social/actions";
import { Flash, SocialNav, StateBadge } from "@/components/social/bits";
import { Icon } from "@/components/icons";
import { NO_DIET_PREFERENCE, idSchema } from "@/contracts/catalog";
import { targetHref, targetKindLabel } from "@/contracts/social";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { SocialError, getList, getMyProfile } from "@/server/social";
import { ListMeals } from "@/components/list-meals";
import { FLAGS } from "@/config/flags";
import { getListMeals } from "@/server/catalog/menu-preview";

export const metadata = { title: "Edit list" };
type Props = { params: Promise<{ id: string }>; searchParams: Promise<RawParams> };

async function Manage({ params, searchParams }: Props) {
  const [{ id: raw }, sp] = await Promise.all([params, searchParams]);
  const id = idSchema.safeParse(raw);
  if (!id.success) notFound();
  const here = `/friends/lists/${id.data}`;
  const member = await getCurrentMember();
  if (!member) redirect(`/login?next=${encodeURIComponent(here)}`);
  let list, me;
  try {
    [list, me] = await Promise.all([getList(id.data, "manage", NO_DIET_PREFERENCE), getMyProfile()]);
  } catch (e) {
    if (e instanceof SocialError && e.status === 404) notFound();
    throw e;
  }
  const isPublic = list.visibility === "public";
  const mealCount = FLAGS.realCatalogPreview ? (await getListMeals(list.listId)).length : 0;
  const canEditorial = me.isCurator || me.isModerator;
  return (
    <>
      <SocialNav active="lists" requests={me.incomingRequests} />
      <Link className="link-btn" href="/friends/lists">
        <Icon name="back" />
        My lists
      </Link>
      <h1 className="title" data-testid="list-title">
        {list.title}
      </h1>
      <p>
        <StateBadge audience={list.visibility} state={list.state} />
        {list.isEditorial && <span className="badge" style={{ marginLeft: 6 }}>Editorial collection</span>}
      </p>
      <Flash sp={sp} />
      {list.state === "removed" && <p className="callout stop">A moderator removed this list from public view. You can edit it and publish again; it will be checked first.</p>}

      <h2 className="h-sec">Items, in order ({list.items.length})</h2>
      {list.items.length === 0 && mealCount > 0 ? null : list.items.length === 0 ? (
        <div className="empty" data-testid="list-empty">
          <p>This list is empty. Open any dish, recipe or place and choose &ldquo;Add to a list&rdquo;.</p>
          <p>
            <Link className="btn primary" href="/discover">
              Browse Discover
            </Link>{" "}
            <Link className="btn" href="/cook">
              Browse recipes
            </Link>
          </p>
        </div>
      ) : (
        <ol className="order" data-testid="list-items">
          {list.items.map((item, i) => (
            <li key={item.itemId}>
              <span className="pos">{i + 1}</span>
              <span className="name">
                <Link href={targetHref(item.target)}>{item.target.name}</Link>
                <span className="muted s14" style={{ fontWeight: 400 }}>
                  {" "}
                  · {targetKindLabel(item.target.kind)}
                  {item.target.venueName ? ` at ${item.target.venueName}` : ""}
                </span>
                {item.note && <span className="s14" style={{ display: "block", fontWeight: 400 }}>{item.note}</span>}
                <FreshTarget target={item.target} block />
              </span>
              <span className="acts">
                {(["up", "down", "remove"] as const).map((op) => (
                  <form key={op} action={listItemAction}>
                    <input type="hidden" name="return" value={here} />
                    <input type="hidden" name="listId" value={list.listId} />
                    <input type="hidden" name="itemId" value={item.itemId} />
                    <button
                      className="btn small"
                      type="submit"
                      name="op"
                      value={op}
                      disabled={(op === "up" && i === 0) || (op === "down" && i === list.items.length - 1)}
                      aria-label={`${op === "up" ? "Move up" : op === "down" ? "Move down" : "Remove"}: ${item.target.name}`}
                    >
                      {op === "up" ? "Move up" : op === "down" ? "Move down" : "Remove"}
                    </button>
                  </form>
                ))}
              </span>
            </li>
          ))}
        </ol>
      )}
      <ListMeals listId={list.listId} returnTo={here} manage />

      <h2 className="h-sec">Sharing</h2>
      {isPublic && list.state === "visible" && (
        <p data-testid="public-link">
          Public link:{" "}
          <Link className="link" href={`/lists/${list.listId}`}>
            /lists/{list.listId}
          </Link>
          . Anyone you give it to can read the list. They cannot change it.
        </p>
      )}
      <div className="inline-forms">
        <form action={listStateAction}>
          <input type="hidden" name="return" value={here} />
          <input type="hidden" name="listId" value={list.listId} />
          {isPublic ? (
            <button className="btn" type="submit" name="op" value="unpublish">
              Make private again
            </button>
          ) : (
            <button className="btn primary" type="submit" name="op" value="publish" disabled={list.items.length === 0}>
              Publish this list
            </button>
          )}
        </form>
        {canEditorial && isPublic && (
          <form action={listStateAction}>
            <input type="hidden" name="return" value={here} />
            <input type="hidden" name="listId" value={list.listId} />
            <button className="btn" type="submit" name="op" value={list.isEditorial ? "editorial_off" : "editorial_on"}>
              {list.isEditorial ? "Stop showing as an editorial collection" : "Show as an editorial collection"}
            </button>
          </form>
        )}
      </div>
      {!isPublic && !me.firstPublicApproved && <p className="s13 muted">Your first public post is checked by a moderator before anyone else can see it.</p>}

      <details className="sheet" style={{ marginTop: 20 }}>
        <summary>Rename or describe</summary>
        <form action={saveListAction} className="sheet-body stack">
          <input type="hidden" name="return" value={here} />
          <input type="hidden" name="listId" value={list.listId} />
          <div>
            <label htmlFor="el-title">Title</label>
            <input id="el-title" type="text" name="title" defaultValue={list.title} maxLength={80} required />
          </div>
          <div>
            <label htmlFor="el-desc">Description (optional)</label>
            <textarea id="el-desc" name="description" defaultValue={list.description ?? ""} maxLength={500} rows={2} />
          </div>
          <button className="btn" type="submit">
            Save
          </button>
        </form>
      </details>
      <details className="sheet" style={{ marginTop: 12 }}>
        <summary>Delete this list</summary>
        <form action={listStateAction} className="sheet-body stack">
          <input type="hidden" name="return" value={here} />
          <input type="hidden" name="listId" value={list.listId} />
          <p style={{ margin: 0 }}>This removes the list and its public link for good. The places and dishes themselves are not affected.</p>
          <button className="btn danger" type="submit" name="op" value="delete">
            Delete list
          </button>
        </form>
      </details>
    </>
  );
}

export default function Page(props: Props) {
  return (
    <AppShell active="friends" narrow>
      <Suspense fallback={<Loading />}>
        <Manage {...props} />
      </Suspense>
    </AppShell>
  );
}
