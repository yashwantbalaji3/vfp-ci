import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell, Loading } from "@/components/app-shell";
import { SignInPrompt } from "@/components/social/bits";
import { FLAGS } from "@/config/flags";
import { REPORT_WORDS, RESOLUTIONS, RESOLUTION_WORDS, type ReportsQueue } from "@/contracts/places";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { getReportsQueue } from "@/server/catalog/places";
import { SocialError } from "@/server/social";
import { resolveReportAction } from "../../actions";
import { FounderOnly } from "../bits";

export const metadata = { title: "Visitor reports", robots: { index: false, follow: false } };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" });

async function Reports({ searchParams }: { searchParams: Promise<RawParams> }) {
  const sp = await searchParams;
  const member = await getCurrentMember();
  if (!member) {
    return (
      <SignInPrompt next="/places/review/reports">
        <p>Visitor reports are for the founder. Sign in to continue.</p>
      </SignInPrompt>
    );
  }
  const all = first(sp.all) === "1";
  let data: ReportsQueue;
  try {
    data = await getReportsQueue(!all);
  } catch (e) {
    if (e instanceof SocialError && (e.status === 403 || e.status === 401)) return <FounderOnly />;
    return (
      <div className="callout stop" role="alert">
        <strong>We couldn&rsquo;t load the reports just now.</strong> <Link href="/places/review/reports">Try again</Link>
      </div>
    );
  }
  return (
    <>
      {first(sp.m) === "resolved" && (
        <p className="callout calm" role="status" data-testid="reports-message">
          Report resolved. The listing itself did not change.
        </p>
      )}
      {first(sp.e) && (
        <p className="callout stop" role="alert">
          That was not recorded. Please try again.
        </p>
      )}
      <p data-testid="reports-open">
        {data.open} open {data.open === 1 ? "report" : "reports"}.{" "}
        <Link href={all ? "/places/review/reports" : "/places/review/reports?all=1"}>{all ? "Show open only" : "Show resolved too"}</Link>
      </p>
      <p className="s14 muted">
        A report never changes a listing by itself. If a place is wrong, decide it in identity review (reject or ask for more evidence), then mark the report fixed. The person who reported is never shown here.
      </p>
      {data.items.length === 0 ? (
        <p className="muted">No reports.</p>
      ) : (
        <ul className="feed" data-testid="reports-list">
          {data.items.map((r) => (
            <li key={r.id} className="post" data-testid="report-row">
              <div className="head">
                <Link href={`/places/${r.listing.slug}`} style={{ fontWeight: 700, overflowWrap: "anywhere" }}>
                  {r.listing.name}
                </Link>
                <span className={`badge ${r.resolution ? "ok" : "wait"}`}>{r.resolution ? RESOLUTION_WORDS[r.resolution].split(" (")[0] : "Open"}</span>
              </div>
              <p className="s14 muted" style={{ margin: "4px 0 0" }}>
                {r.listing.street}, {r.listing.postcode} · reported {when(r.createdAt)}
              </p>
              <p style={{ margin: "4px 0 0" }}>
                <strong>{REPORT_WORDS[r.reason]}</strong>
                {r.note ? `: ${r.note}` : ""}
              </p>
              {r.inReview && (
                <p className="s14" style={{ margin: "4px 0 0" }}>
                  <Link href={`/places/review/${r.listing.candidateId}`}>Open it in identity review</Link>
                </p>
              )}
              {!r.resolution ? (
                <form action={resolveReportAction} className="stack" style={{ marginTop: 8 }}>
                  <input type="hidden" name="reportId" value={r.id} />
                  <div>
                    <label htmlFor={`res-${r.id}`}>Resolution</label>
                    <select id={`res-${r.id}`} name="resolution" required defaultValue="">
                      <option value="" disabled>
                        Choose…
                      </option>
                      {RESOLUTIONS.map((x) => (
                        <option key={x} value={x}>
                          {RESOLUTION_WORDS[x]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor={`rn-${r.id}`}>Note (optional)</label>
                    <textarea id={`rn-${r.id}`} name="note" maxLength={500} rows={2} style={{ width: "100%" }} />
                  </div>
                  <button className="btn" type="submit" data-testid="report-resolve">
                    Resolve report
                  </button>
                </form>
              ) : (
                r.resolutionNote && <p className="s14 muted" style={{ margin: "4px 0 0" }}>Note: {r.resolutionNote}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export default function ReportsPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  if (!FLAGS.realCatalogPreview) notFound();
  return (
    <AppShell active="discover" realPlaces>
      <p className="eyebrow">Private · founder only</p>
      <h1 className="title">Visitor reports</h1>
      <p>
        <Link href="/places/review">← Identity review</Link>
      </p>
      <Suspense fallback={<Loading label="Loading reports…" />}>
        <Reports searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}
