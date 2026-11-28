import { AppShell } from "@/components/app-shell";
import { LEGAL_TEXT_APPROVED, LEGAL_VERSION, type LegalSection } from "@/content/legal";

/** One plain page for the privacy notice or the terms. Says "Draft" until the owner approves the wording. */
export function LegalPage({ title, sections, testId }: { title: string; sections: LegalSection[]; testId: string }) {
  return (
    <AppShell active="none" narrow>
      <h1 className="title">{title}</h1>
      {LEGAL_TEXT_APPROVED ? (
        <p className="s14 muted">Version {LEGAL_VERSION}</p>
      ) : (
        <p className="dchip draft" data-testid="legal-draft">
          Draft for review, not yet in force
        </p>
      )}
      <div data-testid={testId}>
        {sections.map((s) => (
          <section key={s.heading}>
            <h2 className="s16" style={{ margin: "18px 0 6px" }}>
              {s.heading}
            </h2>
            {s.paragraphs.map((p) => (
              <p key={p}>{p}</p>
            ))}
            {!LEGAL_TEXT_APPROVED && s.review && s.review.length > 0 && (
              <div className="callout" data-testid="legal-review">
                <strong>For the owner&rsquo;s review:</strong>
                <ul style={{ margin: "4px 0 0" }}>
                  {s.review.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        ))}
      </div>
    </AppShell>
  );
}
