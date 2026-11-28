"use client";
import { useEffect, useRef, useState } from "react";
import { formatClock, timerWords } from "@/domain/recipes/quantity";

type Saved = { endsAt: number | null; remaining: number };

/**
 * An optional countdown for one step. It never starts by itself. The end time is kept
 * in this browser tab, so reloading the page or moving between steps does not lose it.
 * When time is up the step says so in words (announced to screen readers) and plays a
 * short tone where the browser allows it. No notifications are sent.
 */
export function StepTimer({ storageKey, seconds }: { storageKey: string; seconds: number }) {
  const [saved, setSaved] = useState<Saved>({ endsAt: null, remaining: seconds });
  const [now, setNow] = useState(0);
  const [ready, setReady] = useState(false);
  const beeped = useRef(false);

  // Read any saved timer once the page is in the browser (storage does not exist on the server).
  useEffect(() => {
    const t = window.setTimeout(() => {
      let initial: Saved = { endsAt: null, remaining: seconds };
      try {
        const raw = window.sessionStorage.getItem(storageKey);
        if (raw) initial = JSON.parse(raw) as Saved;
      } catch {
        // Storage is unavailable (private mode): the timer still works until the page reloads.
      }
      // A timer that ran out while the page was closed is shown as done, without a late tone.
      if (initial.endsAt !== null && initial.endsAt <= Date.now()) beeped.current = true;
      setSaved(initial);
      setNow(Date.now());
      setReady(true);
    }, 0);
    return () => window.clearTimeout(t);
  }, [storageKey, seconds]);

  const running = saved.endsAt !== null;
  const left = running ? Math.max(0, ((saved.endsAt as number) - now) / 1000) : saved.remaining;
  const done = ready && left <= 0;
  const started = running || saved.remaining !== seconds;

  useEffect(() => {
    if (!running || done) return;
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [running, done]);

  useEffect(() => {
    if (!done || beeped.current) return;
    beeped.current = true;
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.value = 0.08;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.6);
      osc.onended = () => void ctx.close();
    } catch {
      // Sound is a bonus. The words on screen are the signal.
    }
  }, [done]);

  const store = (next: Saved) => {
    setSaved(next);
    setNow(Date.now());
    try {
      window.sessionStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // see above
    }
  };
  const start = () => {
    beeped.current = false;
    store({ endsAt: Date.now() + left * 1000, remaining: left });
  };
  const pause = () => store({ endsAt: null, remaining: Math.max(0, Math.ceil(left)) });
  const reset = () => {
    beeped.current = false;
    store({ endsAt: null, remaining: seconds });
  };

  return (
    <div className={`timer ${done ? "done" : ""}`} data-testid="step-timer" data-state={done ? "done" : running ? "running" : started ? "paused" : "idle"}>
      <div className="timer-face">
        <span className="timer-label">{done ? "Time's up" : started ? "Timer" : `Optional timer · ${timerWords(seconds)}`}</span>
        {(started || done) && (
          <span className="timer-clock" role="timer" aria-live="off" data-testid="timer-clock">
            {formatClock(left)}
          </span>
        )}
      </div>
      <div className="row">
        {!done && !running && (
          <button type="button" className="btn" onClick={start} data-testid="timer-start">
            {started ? "Resume timer" : `Start ${timerWords(seconds)} timer`}
          </button>
        )}
        {!done && running && (
          <button type="button" className="btn" onClick={pause} data-testid="timer-pause">
            Pause timer
          </button>
        )}
        {(started || done) && (
          <button type="button" className="btn" onClick={reset} data-testid="timer-reset">
            Reset
          </button>
        )}
      </div>
      <p className="sr-only" role="status" aria-live="assertive">
        {done ? "Time's up for this step." : ""}
      </p>
    </div>
  );
}
