import { Suspense } from "react";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { SignInPrompt } from "@/components/social/bits";
import { feedbackSummary, LABELS, USED } from "@/contracts/beta-feedback";
import { getCurrentMember } from "@/server/auth/session";
import { getAllFeedback } from "@/server/member/feedback";

export const metadata = { title: "Tester feedback (private)", robots: { index: false, follow: false } };
const word = (list: readonly { v: string; label: string }[], v: unknown) => list.find((o) => o.v === v)?.label ?? String(v ?? "");

/** The founder's view of tester feedback, by tester code only (migration 20261123000300). */
async function All() {
  const member = await getCurrentMember();
  if (!member) {
    return (
      <SignInPrompt next="/feedback/all">
        <p>This private page is for the founder. Sign in to continue.</p>
      </SignInPrompt>
    );
  }
  const rows = await getAllFeedback();
  if (!rows) notFound();
  const s = feedbackSummary(rows);
  return (
    <>
      <section className="panel" data-testid="feedback-summary" style={{ marginBottom: 16 }}>
        <h2 className="h-sec" style={{ marginTop: 0 }}>
          {s.testers} {s.testers === 1 ? "tester" : "testers"}, {s.weekAnswers} weekly answers, {s.notes} notes
        </h2>
        <p className="s14" style={{ margin: 0 }}>
          Trust {s.trust ?? "no answers yet"}
          {s.trust !== null ? " of 5" : ""} · recommend {s.recommend ?? "no answers yet"}
          {s.recommend !== null ? " of 5" : ""} · {s.labelsWrong} said at least one diet label was wrong
        </p>
      </section>
      {rows.length === 0 ? (
        <p className="muted">No feedback yet.</p>
      ) : (
        <ul className="stack" style={{ listStyle: "none", padding: 0 }}>
          {rows.map((r) => (
            <li key={r.id} className="panel s14" data-testid="feedback-all-item">
              <strong>Tester {r.tester}</strong> <span className="muted">· {r.createdAt.slice(0, 16).replace("T", " ")} UTC · {r.form === "week" ? "weekly answers" : "note"}</span>
              {r.form === "week" ? (
                <p style={{ margin: "4px 0" }}>
                  Used: {word(USED, r.answers.used)}. Labels: {word(LABELS, r.answers.labels)}. Trust {String(r.answers.trust)}/5. Recommend {String(r.answers.recommend)}/5.
                  {r.answers.wrong ? ` Wrong: ${String(r.answers.wrong)}` : ""}
                  {r.answers.missing ? ` Missing: ${String(r.answers.missing)}` : ""}
                </p>
              ) : (
                <p style={{ margin: "4px 0" }}>
                  {String(r.answers.text ?? "")}
                  {r.answers.page ? <span className="muted"> (on {String(r.answers.page)})</span> : null}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export default function AllFeedbackPage() {
  return (
    <AppShell active="account">
      <p className="eyebrow">Private</p>
      <h1 className="title">Tester feedback</h1>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <All />
      </Suspense>
    </AppShell>
  );
}
