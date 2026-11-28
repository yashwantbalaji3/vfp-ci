import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell, Loading } from "@/components/app-shell";
import { EditEntryForm } from "@/components/diary/edit-entry-form";
import { Icon } from "@/components/icons";
import { idSchema } from "@/contracts/catalog";
import { DIARY_NUTRIENTS, isoDateSchema } from "@/contracts/diary";
import { portionText } from "@/domain/diary/summary";
import { amountText, formatDay, methodLabel } from "@/lib/format";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { getDiaryDay } from "@/server/diary";
import { deleteEntryAction } from "../actions";
import { one } from "../params";

export const metadata = { title: "Edit entry" };
type Props = { searchParams: Promise<RawParams> };

async function Edit({ searchParams }: Props) {
  const sp = await searchParams;
  const entryId = idSchema.safeParse(one(sp.entry));
  const date = isoDateSchema.safeParse(one(sp.date));
  if (!entryId.success || !date.success) redirect("/diary");
  const member = await getCurrentMember();
  if (!member) redirect(`/login?next=${encodeURIComponent(`/diary?date=${date.data}`)}`);
  const day = await getDiaryDay(date.data);
  // Looked up inside the member's own day, so another person's entry id simply isn't found.
  const entry = day.entries.find((e) => e.entryId === entryId.data);
  if (!entry) {
    return (
      <div className="panel" data-testid="edit-missing">
        <p style={{ marginTop: 0 }}>We couldn&rsquo;t find that entry. It may have been removed or moved to another day.</p>
        <Link className="btn primary" href={`/diary?date=${date.data}`}>
          Back to your diary
        </Link>
      </div>
    );
  }
  return (
    <>
      <h1 className="title" data-testid="edit-name">
        {entry.name}
      </h1>
      <p className="muted" style={{ marginTop: 0 }}>
        {formatDay(date.data)} · {portionText(entry.portion, entry.quantity)}
      </p>
      <dl className="nutri" data-testid="edit-nutrients">
        {DIARY_NUTRIENTS.map((n) => {
          const cell = entry.nutrients[n.code];
          return (
            <div key={n.code}>
              <dt>{n.label}</dt>
              <dd>{cell && cell.value !== null ? `${amountText(cell.value, n.unit, cell.method, cell.lower, cell.upper)} · ${methodLabel(cell.method)}` : "Not known"}</dd>
            </div>
          );
        })}
      </dl>
      <h2 className="h-sec">Change this entry</h2>
      {entry.editable ? (
        <EditEntryForm entry={entry} date={date.data} />
      ) : (
        <p className="callout">The food this entry came from was removed, so its amount can&rsquo;t be changed. The recorded numbers are kept. You can still remove the entry.</p>
      )}
      <form action={deleteEntryAction} style={{ marginTop: 24 }}>
        <input type="hidden" name="entryId" value={entry.entryId} />
        <input type="hidden" name="expectedVersion" value={entry.version} />
        <input type="hidden" name="date" value={date.data} />
        <button className="btn" type="submit">
          Remove this entry
        </button>
        <p className="s13 muted" style={{ margin: "6px 0 0" }}>
          You can undo a removal for 15 minutes.
        </p>
      </form>
      <p className="s13 muted" style={{ marginTop: 24 }}>
        The numbers come from this food as it was when you logged it. Later changes to the catalog don&rsquo;t alter them.
      </p>
    </>
  );
}

export default function EditPage(props: Props) {
  return (
    <AppShell active="diary" narrow>
      <Link className="link-btn" href="/diary">
        <Icon name="back" />
        Food Diary
      </Link>
      <Suspense fallback={<Loading />}>
        <Edit {...props} />
      </Suspense>
    </AppShell>
  );
}
