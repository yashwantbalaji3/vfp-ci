import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { MealListSkeleton } from "@/components/menu-preview";
import { SignInPrompt } from "@/components/social/bits";
import { FLAGS } from "@/config/flags";
import type { MenuFact } from "@/contracts/menu-review";
import { FILTER_WORDS, FILTERS, tallyOf, workload, type DietOutcome, type Filter } from "@/contracts/verification";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { getVerificationDryRun, type VerifiedMeal } from "@/server/catalog/verification";

/**
 * Verification dry run (owner directive 28 Nov 2026 04:59 UTC, parts 2 and 3). Founder only. Shows how a documented
 * policy would sort every source-backed meal, so the founder can review groups and exceptions instead of every row.
 * It approves, includes and publishes nothing: no button here changes any record.
 */
const SOURCE_WORDS = { A: "Matches the saved source", B: "Needs a person (source)", E: "Source unavailable or outdated" } as const;
const DIET_WORDS: Record<DietOutcome, string> = { candidate: "Diet candidate", B: "Needs a person (diet)", C: "Excluded", D: "Insufficient evidence" };
const NEXT: Record<string, string> = {
  B_source: "Open the meal, compare the flagged fact with the saved page, and correct or confirm it.",
  E_source: "Find a current source for this branch; until then the fact stays out of any current claim.",
  B_diet: "Decide whether the restaurant's word or the printed ingredient wins, or ask for a restaurant source.",
};
const VIEWS = [
  { key: "all", label: "All meals" },
  { key: "proposed", label: "Proposed selection" },
] as const;

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "0%");
const flagged = (f: MenuFact) => f.machineCheck && f.machineCheck.result !== "found" && !f.unknown;

async function DryRun({ searchParams }: { searchParams: Promise<RawParams> }) {
  const sp = await searchParams;
  const member = await getCurrentMember();
  if (!member) {
    return (
      <SignInPrompt next="/places/review/verification">
        <p>This private page is for the founder. Sign in to continue.</p>
      </SignInPrompt>
    );
  }
  const all = await getVerificationDryRun();
  if (!all) notFound();
  const view = sp.view === "proposed" ? "proposed" : "all";
  const rows = view === "proposed" ? all.filter((r) => r.proposed) : all;
  const t = tallyOf(rows.map((r) => r.v));
  const w = workload(rows.map((r) => r.v));
  const exceptions = rows.filter((r) => r.v.source !== "A" || FILTERS.some((f) => r.v.diet[f].outcome === "B"));
  const counts = { view, meals: t.dishes, source: t.source, sourceReasons: t.sourceReasons, dietReasons: t.dietReasons, diet: t.diet, eligible: t.eligible, nutrition: t.nutrition, published: t.published, workload: w, proposed: all.filter((r) => r.proposed).length };

  return (
    <>
      <p className="callout" role="note" data-testid="vr-dry-run">
        <strong>Dry run.</strong> This shows how the proposed verification policy would sort the meals. Nothing here approves a diet, includes a meal for members or publishes
        anything, and the five results are separate: a meal that matches its source is not thereby vegan, egg-free or safe for allergies.
      </p>
      <script type="application/json" data-testid="vr-counts" dangerouslySetInnerHTML={{ __html: JSON.stringify(counts) }} />
      <nav className="tabs" aria-label="Which meals" style={{ marginBottom: 12 }}>
        {VIEWS.map((v) => (
          <Link key={v.key} href={`/places/review/verification?view=${v.key}`} aria-current={v.key === view ? "page" : undefined} className={`chip${v.key === view ? " on" : ""}`} data-testid={`vr-view-${v.key}`}>
            {v.label}
            {v.key === "proposed" ? ` (${counts.proposed})` : ` (${all.length})`}
          </Link>
        ))}
      </nav>

      <section className="panel" style={{ marginBottom: 16 }} data-testid="vr-source">
        <h2 className="h-sec" style={{ marginTop: 0 }}>1. Source: does the record match the saved page?</h2>
        <ul className="s14">
          {(["A", "B", "E"] as const).map((k) => (
            <li key={k} data-testid={`vr-source-${k}`}>
              <strong>{SOURCE_WORDS[k]}:</strong> {t.source[k]} of {t.dishes} ({pct(t.source[k], t.dishes)})
            </li>
          ))}
        </ul>
        {Object.keys(t.sourceReasons).length ? (
          <details>
            <summary className="s14">Why meals need a person or a newer source</summary>
            <ul className="s14">
              {Object.entries(t.sourceReasons).sort((a, b) => b[1] - a[1]).map(([k, n]) => (
                <li key={k}>{k}: {n}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      <section className="panel" style={{ marginBottom: 16 }} data-testid="vr-diet">
        <h2 className="h-sec" style={{ marginTop: 0 }}>2. Diet evidence, per filter</h2>
        <p className="s13 muted" style={{ marginTop: 0 }}>
          The same rule Discover uses. A candidate needs the restaurant&rsquo;s own word, found on the saved page, and nothing printed against it. Silence is never a yes.
        </p>
        <div style={{ overflowX: "auto" }}>
          <table className="s14" style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Filter</th>
                {(["candidate", "B", "C", "D"] as const).map((k) => (
                  <th key={k} style={{ textAlign: "right" }}>{DIET_WORDS[k]}</th>
                ))}
                <th style={{ textAlign: "right" }}>Would be eligible</th>
              </tr>
            </thead>
            <tbody>
              {FILTERS.map((f) => (
                <tr key={f} data-testid={`vr-diet-${f}`}>
                  <td>{FILTER_WORDS[f]}</td>
                  {(["candidate", "B", "C", "D"] as const).map((k) => (
                    <td key={k} style={{ textAlign: "right" }}>{t.diet[f][k]}</td>
                  ))}
                  <td style={{ textAlign: "right" }}>{t.eligible[f]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <details>
          <summary className="s14">Reasons, by filter</summary>
          {FILTERS.map((f) => (
            <div key={f}>
              <p className="s14" style={{ marginBottom: 4 }}><strong>{FILTER_WORDS[f]}</strong></p>
              <ul className="s13">
                {Object.entries(t.dietReasons[f]).sort((a, b) => b[1] - a[1]).map(([k, n]) => (
                  <li key={k}>{k.replace(/^B:/, "Needs a person:").replace(/^C:/, "Excluded:").replace(/^D:/, "Insufficient:")} ({n})</li>
                ))}
              </ul>
            </div>
          ))}
        </details>
      </section>

      <section className="panel" style={{ marginBottom: 16 }} data-testid="vr-other">
        <h2 className="h-sec" style={{ marginTop: 0 }}>3 to 5. Protein, eligibility and publication</h2>
        <ul className="s14">
          <li>Protein: {Object.entries(t.nutrition).map(([k, n]) => `${k.replace(/_/g, " ")} ${n}`).join(", ")}. Unknown stays unknown, never zero; an estimate is never the restaurant&rsquo;s figure.</li>
          <li>Eligibility is computed only (source match and diet candidate). It is not applied to any screen.</li>
          <li data-testid="vr-published">Published or member-visible because of this page: 0. Currently published among these meals: {t.published}.</li>
        </ul>
        <p className="s14" data-testid="vr-workload">
          <strong>Your workload if you adopt the policy:</strong> {w.transcriptionChecksReplaceable} of {w.meals} meals would need no fact-by-fact transcription check from you;{" "}
          {w.stillNeedSourceException} still need a source exception, and {w.dietExceptions} have a diet question for a person.
        </p>
      </section>

      <section data-testid="vr-exceptions">
        <h2 className="h-sec">Exceptions ({exceptions.length})</h2>
        {exceptions.length === 0 ? <p className="s14">No exceptions in this view.</p> : null}
        <ul style={{ listStyle: "none", padding: 0 }}>
          {exceptions.slice(0, 200).map((r) => (
            <Exception key={r.m.dishId} r={r} />
          ))}
        </ul>
        {exceptions.length > 200 ? <p className="s13 muted">Showing the first 200.</p> : null}
      </section>
    </>
  );
}

function Exception({ r }: { r: VerifiedMeal }) {
  const d = r.menu.dishes.find((x) => x.dishId === r.m.dishId);
  const facts = (d?.facts ?? []).filter(flagged);
  const dietB = FILTERS.filter((f: Filter) => r.v.diet[f].outcome === "B");
  return (
    <li className="panel" style={{ marginBottom: 10 }} data-testid="vr-exception">
      <p className="s14" style={{ margin: 0 }}>
        <Link href={`/places/review/queue/preview/${r.m.dishId}`}>
          <strong>{r.m.label}</strong>
        </Link>{" "}
        · {r.p.name} {r.proposed ? <span className="chip">proposed</span> : null}
      </p>
      {r.v.source !== "A" ? (
        <>
          <p className="s13" style={{ margin: "6px 0 0" }}>
            <strong>{SOURCE_WORDS[r.v.source]}.</strong> {r.v.sourceReasons.slice(0, 3).join(" ")}
          </p>
          {facts.slice(0, 3).map((f) => (
            <p key={f.factId} className="s13 muted" style={{ margin: "2px 0 0" }}>
              Automatic comparison: {f.machineCheck?.detail}
            </p>
          ))}
          <p className="s13" style={{ margin: "4px 0 0" }}>Next: {NEXT[`${r.v.source}_source`]}</p>
        </>
      ) : null}
      {dietB.length ? (
        <>
          {dietB.map((f) => (
            <p key={f} className="s13" style={{ margin: "6px 0 0" }} data-testid="vr-diet-exception">
              <strong>{FILTER_WORDS[f]}:</strong> {r.v.diet[f].reasons.join("; ")}
            </p>
          ))}
          <p className="s13" style={{ margin: "4px 0 0" }}>Next: {NEXT.B_diet}</p>
        </>
      ) : null}
    </li>
  );
}

export default function VerificationPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  if (!FLAGS.realCatalogPreview) notFound();
  return (
    <AppShell active="discover" realPlaces>
      <p className="eyebrow">Private · founder only</p>
      <h1 className="title">Verification dry run</h1>
      <Suspense fallback={<MealListSkeleton rows={4} />}>
        <DryRun searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}

