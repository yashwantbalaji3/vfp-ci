import type { VenueHours } from "@/contracts/hours";
import { periodWords, weeklyLines } from "@/lib/hours-words";
import { formatDate } from "@/lib/format";
import { HoursStatusLine } from "./hours-status";

/**
 * MAP-2 opening hours on a place page: the status in words, the checked weekly hours,
 * upcoming dated changes, and when they were checked. Out-of-date hours stay visible,
 * clearly labelled as last known and needing confirmation.
 */
export function OpeningHours({ hours }: { hours: VenueHours | null }) {
  const stale = hours?.status.state === "needs_confirmation" && hours.status.reason === "out_of_date";
  return (
    <section className="panel" aria-labelledby="hours-h" data-testid="opening-hours">
      <h2 className="h-sec" id="hours-h" style={{ marginTop: 0 }}>
        Opening hours
      </h2>
      <HoursStatusLine status={hours?.status} />
      {hours?.hours ? (
        <>
          {stale && (
            <p className="callout" style={{ margin: "8px 0" }} data-testid="hours-stale">
              <strong>Last known hours, requiring verification.</strong> Nobody has checked them for more than 60 days, so we never show this
              place as open. Check with the place before going.
            </p>
          )}
          <table className="hours-table">
            <caption className="sr-only">{stale ? "Last known weekly hours" : "Weekly hours"}</caption>
            <tbody>
              {weeklyLines(hours.hours).map((l) => (
                <tr key={l.day}>
                  <th scope="row">{l.day}</th>
                  <td>{l.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {hours.hours.exceptions.length > 0 && (
            <ul className="s14" style={{ margin: "4px 0", paddingLeft: 18 }} data-testid="hours-exceptions">
              {hours.hours.exceptions.map((e) => (
                <li key={`${e.startsOn}-${e.kind}-${e.opens}`}>
                  {dateRange(e.startsOn, e.endsOn)}:{" "}
                  {e.kind === "special_hours" && e.opens && e.closes
                    ? `open ${periodWords({ opens: e.opens, closes: e.closes, closesNextDay: e.closesNextDay })} only`
                    : e.kind === "temporary_closure"
                      ? "temporarily closed"
                      : "closed"}
                  {e.reason ? ` · ${e.reason}` : ""}
                </li>
              ))}
            </ul>
          )}
          <p className="s13 muted" style={{ margin: "4px 0 0" }}>
            Times are local to the place. Checked {formatDate(hours.checkedAt) ?? "on an unrecorded date"}
            {sourceName(hours.source) ? ` from ${sourceName(hours.source)}` : ""}.
          </p>
        </>
      ) : (
        <p className="s14 muted" style={{ margin: "4px 0 0" }}>
          Nobody has checked this place&rsquo;s opening hours yet, so it never appears under &ldquo;Open now&rdquo;.
        </p>
      )}
    </section>
  );
}

function dateRange(from: string, to: string): string {
  const f = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  return from === to ? f(from) : `${f(from)} to ${f(to)}`;
}

function sourceName(source: Record<string, unknown> | null): string | null {
  const p = source?.publisher;
  return typeof p === "string" && p ? p : null;
}

