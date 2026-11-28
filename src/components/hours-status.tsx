import type { HoursStatus } from "@/contracts/hours";
import { hoursWords } from "@/lib/hours-words";

/**
 * MAP-2 opening status in words, with a small mark that is never the only signal.
 * Only the database's "open" is ever shown as open. `now` is passed in so the
 * server and the browser use the same moment.
 */
export function HoursStatusLine({ status, now, className = "" }: { status: HoursStatus | null | undefined; now?: Date; className?: string }) {
  const w = hoursWords(status, now);
  return (
    <p className={`hours-line hours-${w.tone} ${className}`} data-testid="hours-status" data-state={status?.state ?? "needs_confirmation"} data-soon={status?.state === "open" && status.closesSoon ? "yes" : undefined}>
      <span aria-hidden="true" className="hours-mark">
        {w.tone === "open" ? "●" : w.tone === "closed" ? "○" : "?"}
      </span>{" "}
      <span>{w.label}</span>
      {w.detail && <span className="muted"> · {w.detail}</span>}
    </p>
  );
}
