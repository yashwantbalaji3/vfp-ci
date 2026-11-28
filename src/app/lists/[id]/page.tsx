import { Suspense } from "react";
import { FreshTarget } from "@/components/freshness";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell, Loading } from "@/components/app-shell";
import { DietChip } from "@/components/diet-chip";
import { DietNote, Flash, PersonRow, ReportForm, SignInPrompt } from "@/components/social/bits";
import { Icon } from "@/components/icons";
import { FLAGS } from "@/config/flags";
import { idSchema } from "@/contracts/catalog";
import { targetHref, targetKindLabel } from "@/contracts/social";
import { hasDietChoice } from "@/domain/dietary/labels";
import { formatDate } from "@/lib/format";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { readDietPreference } from "@/server/catalog/diet";
import { SocialError, getList } from "@/server/social";
import { ListMeals } from "@/components/list-meals";
import { limitNotice } from "@/components/too-many-requests";
import { pageLimit } from "@/server/page-limit";

export const metadata = { title: "List" };
type Props = { params: Promise<{ id: string }>; searchParams: Promise<RawParams> };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

async function ListPage({ params, searchParams }: Props) {
  const refused = limitNotice(await pageLimit());
  if (refused) return refused;
  const [{ id: raw }, sp] = await Promise.all([params, searchParams]);
  const id = idSchema.safeParse(raw);
  if (!id.success) notFound();
  const here = `/lists/${id.data}`;
  const member = await getCurrentMember();
  if (!member && !FLAGS.socialPublicEnabled) {
    return (
      <SignInPrompt next={here}>
        <h1 className="title-sm">Sign in to see this list</h1>
        <p>Shared lists are open to signed-in members for now.</p>
      </SignInPrompt>
    );
  }
  const view = one(sp.view) === "needs_confirmation" ? "needs_confirmation" : "matches";
  const diet = await readDietPreference();
  let list;
  try {
    list = await getList(id.data, view, diet);
  } catch (e) {
    if (e instanceof SocialError && e.status === 404) notFound();
    throw e;
  }
  const strict = hasDietChoice(diet);
  const hiddenByFilter = list.itemCount - list.items.length - (view === "matches" ? list.needsConfirmationCount : 0);
  return (
    <>
      <Link className="link-btn" href="/friends">
        <Icon name="back" />
        Friends &amp; Lists
      </Link>
      <p className="eyebrow">{list.isEditorial ? "Editorial collection · chosen by our team" : "List"}</p>
      <h1 className="title" data-testid="list-title">
        {list.title}
      </h1>
      {list.description && <p className="lede">{list.description}</p>}
      {list.owner && (
        <p>
          <PersonRow person={list.owner} note={list.publishedAt ? `published ${formatDate(list.publishedAt)}` : undefined} />
        </p>
      )}
      {list.owner?.isDemo && (
        <p className="callout">
          <strong>Demo content.</strong> This list was invented for testing.
        </p>
      )}
      <Flash sp={sp} />
      {list.isMine && (
        <p>
          <Link className="btn" href={`/friends/lists/${list.listId}`}>
            Edit this list
          </Link>
        </p>
      )}
      <div className="row" style={{ marginBottom: 12 }}>
        <DietChip diet={diet} returnTo={here} />
      </div>
      {strict && (
        <nav className="seg" aria-label="Result groups" style={{ marginBottom: 12 }}>
          <Link href={here} aria-current={view === "matches" ? "true" : undefined}>
            Fits your filter
          </Link>
          <Link href={`${here}?view=needs_confirmation`} aria-current={view === "needs_confirmation" ? "true" : undefined}>
            Needs confirmation ({list.needsConfirmationCount})
          </Link>
        </nav>
      )}
      {view === "needs_confirmation" && (
        <p className="callout">
          <strong>Not confirmed.</strong> These are not confirmed to fit your filter. Ask before ordering.
        </p>
      )}
      {list.items.length > 0 ? (
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
                  {item.target.kind === "venue" && item.target.neighborhood ? ` · ${item.target.neighborhood}` : ""}
                </span>
                {item.note && <span className="s14" style={{ display: "block", fontWeight: 400 }}>{item.note}</span>}
                <DietNote target={item.target} />
                <FreshTarget target={item.target} block />
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted" data-testid="list-none">
          {view === "needs_confirmation" ? "Nothing on this list is waiting for confirmation." : strict ? "Nothing on this list is confirmed for your dietary filter." : "This list is empty."}
        </p>
      )}
      {list.isMine && <ListMeals listId={list.listId} returnTo={here} />}
      {strict && view === "matches" && hiddenByFilter > 0 && (
        <p className="s14 muted" data-testid="list-hidden-note">
          {hiddenByFilter} {hiddenByFilter === 1 ? "item is" : "items are"} always hidden for your filter.
        </p>
      )}
      {member && !list.isMine && (
        <div style={{ marginTop: 16 }}>
          <ReportForm type="list" id={list.listId} returnTo={here} />
        </div>
      )}
    </>
  );
}

export default function Page(props: Props) {
  return (
    <AppShell active="friends" narrow>
      <Suspense fallback={<Loading />}>
        <ListPage {...props} />
      </Suspense>
    </AppShell>
  );
}
