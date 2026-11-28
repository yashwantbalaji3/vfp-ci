import { Suspense } from "react";
import Link from "next/link";
import { AppShell, Loading } from "@/components/app-shell";
import { SignInPrompt } from "@/components/social/bits";
import { targetHref, targetKindLabel } from "@/contracts/social";
import { formatDate, titleCase } from "@/lib/format";
import { getCurrentMember } from "@/server/auth/session";
import { getMyCorrections } from "@/server/editor";

export const metadata = { title: "Problems you have reported" };

const STATE_WORDS: Record<string, string> = {
  open: "Waiting for an editor",
  accepted: "Accepted",
  rejected: "Not accepted",
  duplicate: "Already reported by someone else",
};

async function Mine() {
  const member = await getCurrentMember();
  if (!member) {
    return (
      <SignInPrompt next="/account/corrections">
        <p>Sign in to see the problems you have reported.</p>
      </SignInPrompt>
    );
  }
  const mine = await getMyCorrections();
  return (
    <>
      <p className="s14 muted">
        Only you and the editors can see these. An accepted report does not change the page by itself: an editor then makes the change with a source, and a second person checks it before it is published.
      </p>
      {mine.length === 0 ? (
        <p className="muted" data-testid="my-corrections-empty">
          You have not reported a problem yet. Use &ldquo;Report a problem&rdquo; on any dish or place.
        </p>
      ) : (
        <ul className="feed" data-testid="my-corrections">
          {mine.map((c) => (
            <li className="post" key={c.correctionId} data-state={c.state}>
              <p className="kind" style={{ margin: 0 }}>
                {titleCase(c.field)} · sent {formatDate(c.sentAt)}
              </p>
              <p className="about" style={{ marginTop: 2 }}>
                {c.target ? (
                  <>
                    <Link href={targetHref(c.target)}>{c.target.name}</Link> <span className="muted s14" style={{ fontWeight: 400 }}>· {targetKindLabel(c.target.kind)}</span>
                  </>
                ) : (
                  "This item is no longer public"
                )}
              </p>
              <p className="text">{c.proposedValue}</p>
              <p className="s14" style={{ margin: "6px 0 0" }} data-testid="my-correction-state">
                <strong>{STATE_WORDS[c.state] ?? titleCase(c.state)}</strong>
                {c.decidedAt ? ` on ${formatDate(c.decidedAt)}` : ""}
                {c.state === "accepted" ? (c.applied ? ". The page has been updated after a second check." : ". The page has not been changed yet.") : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export default function Page() {
  return (
    <AppShell active="account" narrow>
      <h1 className="title">Problems you have reported</h1>
      <Suspense fallback={<Loading />}>
        <Mine />
      </Suspense>
    </AppShell>
  );
}
