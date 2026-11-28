import { Suspense } from "react";
import Link from "next/link";
import { AppShell, Loading } from "@/components/app-shell";
import { flagAction, startChangeAction } from "@/app/editor/actions";
import { PracticeNote, StaffDenied, StaffNav } from "@/components/editor/bits";
import { Flash, SignInPrompt } from "@/components/social/bits";
import { formatDate } from "@/lib/format";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { getItems, getStaffAlerts } from "@/server/editor";

export const metadata = { title: "Find a record", robots: { index: false, follow: false } };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

async function Items({ searchParams }: { searchParams: Promise<RawParams> }) {
  const sp = await searchParams;
  const member = await getCurrentMember();
  if (!member) {
    return (
      <SignInPrompt next="/editor/items">
        <p>Sign in to continue.</p>
      </SignInPrompt>
    );
  }
  const alerts = await getStaffAlerts();
  if (!alerts?.isEditor) return <StaffDenied what="catalog editors" />;
  const q = (one(sp.q) ?? "").slice(0, 80);
  const items = await getItems(q || undefined);
  const back = q ? `/editor/items?q=${encodeURIComponent(q)}` : "/editor/items";
  return (
    <>
      <StaffNav alerts={alerts} here="/editor/items" />
      <Flash sp={sp} />
      <PracticeNote />
      <form method="get" action="/editor/items" role="search" className="row" style={{ marginBottom: 12 }}>
        <label htmlFor="q" className="sr-only">
          Name of a dish, recipe, food or place
        </label>
        <input id="q" name="q" type="search" defaultValue={q} placeholder="Name of a dish, recipe, food or place" autoComplete="off" style={{ flex: "1 1 200px" }} />
        <button className="btn" type="submit">
          Search
        </button>
      </form>

      <h2 className="h-sec">Dishes, recipes and foods ({items.foods.length})</h2>
      {items.foods.length === 0 ? (
        <p className="muted">Nothing published matches.</p>
      ) : (
        <ul className="feed" data-testid="editor-foods">
          {items.foods.map((f) => (
            <li className="post" key={f.foodItemId} data-item={f.foodItemId}>
              <div className="head">
                <Link className="link" href={f.kind === "recipe" ? `/cook/${f.foodItemId}` : `/foods/${f.foodItemId}`} style={{ fontWeight: 700 }}>
                  {f.name}
                </Link>
                <span className="badge">{f.kind}</span>
              </div>
              <p className="s13 muted" style={{ margin: "4px 0 0" }}>
                {f.venueName ? `${f.venueName} · ` : ""}version {f.revisionNo}
                {f.publishedAt ? ` · checked ${formatDate(f.publishedAt)}` : ""}
                {f.isDemo ? " · demo data" : ""}
              </p>
              {f.flagged && (
                <p className="s13" style={{ margin: "6px 0 0" }}>
                  <span className="badge wait">Marked as needing review</span>
                </p>
              )}
              <div className="row" style={{ marginTop: 10 }}>
                {f.openChangeId ? (
                  <Link className="btn small" href={`/editor/changes/${f.openChangeId}`}>
                    Open the change in progress
                  </Link>
                ) : (
                  <form action={startChangeAction}>
                    <input type="hidden" name="return" value={back} />
                    <input type="hidden" name="foodItemId" value={f.foodItemId} />
                    <button className="btn small" type="submit">
                      Start a change
                    </button>
                  </form>
                )}
              </div>
              {!f.flagged && (
                <details className="sheet">
                  <summary>Mark as needing review</summary>
                  <form action={flagAction} className="stack" style={{ marginTop: 8 }}>
                    <input type="hidden" name="return" value={back} />
                    <input type="hidden" name="foodItemId" value={f.foodItemId} />
                    <p className="s14 muted">Use this when evidence conflicts. The record leaves every dietary filter at once and comes back only when a checked version is published.</p>
                    <div>
                      <label htmlFor={`fr-${f.foodItemId}`} className="s14">
                        Why it needs review
                      </label>
                      <input id={`fr-${f.foodItemId}`} type="text" name="reason" required minLength={3} maxLength={300} autoComplete="off" />
                    </div>
                    <button className="btn small" type="submit">
                      Mark as needing review
                    </button>
                  </form>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}

      <h2 className="h-sec">Places ({items.venues.length})</h2>
      {items.venues.length === 0 ? (
        <p className="muted">Nothing published matches.</p>
      ) : (
        <ul className="feed" data-testid="editor-venues">
          {items.venues.map((v) => (
            <li className="post" key={v.venueId}>
              <div className="head">
                <Link className="link" href={`/venues/${v.venueId}`} style={{ fontWeight: 700 }}>
                  {v.name}
                </Link>
                <span className="badge">{v.status.replace("_", " ")}</span>
              </div>
              <p className="s13 muted" style={{ margin: "4px 0 0" }}>
                {v.neighborhood ? `${v.neighborhood} · ` : ""}
                {v.reviewedAt ? `checked ${formatDate(v.reviewedAt)}` : "never checked"}
                {v.isDemo ? " · demo data" : ""}
              </p>
              <div className="row" style={{ marginTop: 10 }}>
                {v.openChangeId ? (
                  <Link className="btn small" href={`/editor/changes/${v.openChangeId}`}>
                    Open the change in progress
                  </Link>
                ) : (
                  <form action={startChangeAction}>
                    <input type="hidden" name="return" value={back} />
                    <input type="hidden" name="venueId" value={v.venueId} />
                    <button className="btn small" type="submit">
                      Start a change
                    </button>
                  </form>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export default function EditorItemsPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  return (
    <AppShell active="none" narrow>
      <h1 className="title">Find a record</h1>
      <Suspense fallback={<Loading />}>
        <Items searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}
