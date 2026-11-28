"use client";
import { useActionState } from "react";
import { sendMagicLink, type LoginState } from "./actions";

export function LoginForm({ next }: { next?: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(sendMagicLink, { status: "idle" });
  return (
    <form action={action} className="panel" noValidate>
      {next && <input type="hidden" name="next" value={next} />}
      <label htmlFor="email">Email address</label>
      <input id="email" name="email" type="email" autoComplete="email" required aria-describedby="email-status" />
      <p id="email-status" role="status" aria-live="polite" className={state.status === "error" ? "field-error" : "muted"}>
        {state.message ?? "We'll email you a one-time sign-in link. No password needed."}
      </p>
      <button className="button" type="submit" disabled={pending}>
        {pending ? "Sending…" : "Email me a sign-in link"}
      </button>
    </form>
  );
}
