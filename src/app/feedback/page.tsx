import { Suspense } from "react";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { SignInPrompt } from "@/components/social/bits";
import { LABELS, SCALE, USED } from "@/contracts/beta-feedback";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { getMyFeedback, getMyTesterCode } from "@/server/member/feedback";
import { deleteFeedbackAction, sendNoteAction, sendWeekAction } from "./actions";

export const metadata = { title: "Tell us how it went", robots: { index: false, follow: false } };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const OK: Record<string, string> = {
  week_sent: "Thank you. Your answers are saved.",
  note_sent: "Thank you. Your note is saved.",
  deleted: "Deleted.",
};
const ERR: Record<string, string> = {
  ALREADY_SENT: "You've already answered the weekly questions in the last 6 days. A quick note is always welcome.",
  TOO_MANY: "That's a lot of notes for one day. Please try again tomorrow.",
  INVALID_FEEDBACK: "Please answer each question (the text boxes are optional, up to 500 characters).",
};

async function Feedback({ searchParams }: { searchParams: Promise<RawParams> }) {
  const sp = await searchParams;
  const member = await getCurrentMember();
  if (!member) {
    return (
      <SignInPrompt next="/feedback">
        <p>Sign in to send feedback about the test.</p>
      </SignInPrompt>
    );
  }
  const [code, mine] = await Promise.all([getMyTesterCode(), getMyFeedback()]);
  const ok = OK[one(sp.m) ?? ""];
  const err = one(sp.e) ? (ERR[one(sp.e)!] ?? "That didn't work. Nothing was saved.") : null;
  const from = one(sp.from);
  return (
    <>
      {ok && (
        <p className="callout ok" role="status" data-testid="feedback-ok">
          {ok}
        </p>
      )}
      {err && (
        <p className="callout stop" role="alert" data-testid="feedback-error">
          {err}
        </p>
      )}
      <p className="s14 muted" data-testid="feedback-privacy">
        Only the person running the test reads this, and only under your tester code <strong data-testid="feedback-code">{code}</strong>, not your name or email.
        Please don&rsquo;t include health, weight or allergy details. It is deleted with your account.
      </p>
      <form action={sendWeekAction} className="panel stack" data-testid="feedback-week">
        <h2 className="h-sec" style={{ marginTop: 0 }}>
          After a week
        </h2>
        <fieldset>
          <legend>Did you use it?</legend>
          {USED.map((o) => (
            <label key={o.v} className="row s14" style={{ gap: 6 }}>
              <input type="radio" name="used" value={o.v} required /> {o.label}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>When you checked a meal&rsquo;s diet label against the restaurant, did it match?</legend>
          {LABELS.map((o) => (
            <label key={o.v} className="row s14" style={{ gap: 6 }}>
              <input type="radio" name="labels" value={o.v} required /> {o.label}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Would you order a meal based on what the app says? (1 = not at all, 5 = yes, fully)</legend>
          <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
            {SCALE.map((n) => (
              <label key={n} className="row s14" style={{ gap: 4 }}>
                <input type="radio" name="trust" value={n} required /> {n}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>Would you recommend it to a vegetarian or vegan friend? (1 = no, 5 = definitely)</legend>
          <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
            {SCALE.map((n) => (
              <label key={n} className="row s14" style={{ gap: 4 }}>
                <input type="radio" name="recommend" value={n} required /> {n}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="s14">
          Anything wrong? (optional)
          <textarea name="wrong" maxLength={500} rows={3} />
        </label>
        <label className="s14">
          What was missing? (optional)
          <textarea name="missing" maxLength={500} rows={3} />
        </label>
        <button className="btn primary" type="submit" data-testid="feedback-week-send">
          Send answers
        </button>
      </form>
      <form action={sendNoteAction} className="panel stack" data-testid="feedback-note" style={{ marginTop: 16 }}>
        <h2 className="h-sec" style={{ marginTop: 0 }}>
          A quick note
        </h2>
        {from && /^\/[A-Za-z0-9/_?=&%.-]{0,200}$/.test(from) && <input type="hidden" name="page" value={from} />}
        <label className="s14">
          What happened, or what would help?
          <textarea name="text" minLength={3} maxLength={500} rows={3} required />
        </label>
        <button className="btn" type="submit" data-testid="feedback-note-send">
          Send note
        </button>
      </form>
      <h2 className="h-sec">What you&rsquo;ve sent</h2>
      {mine.length === 0 ? (
        <p className="muted s14" data-testid="feedback-none">
          Nothing yet.
        </p>
      ) : (
        <ul className="stack" style={{ listStyle: "none", padding: 0 }} data-testid="feedback-mine">
          {mine.map((r) => (
            <li key={r.id} className="panel s14" data-testid="feedback-item">
              <strong>{r.form === "week" ? "Weekly answers" : "Note"}</strong> <span className="muted">· {r.createdAt.slice(0, 10)}</span>
              <p style={{ margin: "4px 0" }}>{r.form === "note" ? String(r.answers.text ?? "") : `Trust ${String(r.answers.trust)}/5 · recommend ${String(r.answers.recommend)}/5`}</p>
              <form action={deleteFeedbackAction}>
                <input type="hidden" name="id" value={r.id} />
                <button className="link-btn s13" type="submit" data-testid="feedback-delete">
                  Delete
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export default function FeedbackPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  return (
    <AppShell active="account" narrow>
      <p className="eyebrow">Invite-only test</p>
      <h1 className="title">Tell us how it went</h1>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <Feedback searchParams={searchParams} />
      </Suspense>
      <p className="s13 muted" style={{ marginTop: 24 }}>
        <Link href="/account">Back to your account</Link>
      </p>
    </AppShell>
  );
}
