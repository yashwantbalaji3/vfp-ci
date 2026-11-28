import type { WeeklyHours } from "@/contracts/hours";
import { DAY_NAMES } from "@/lib/hours-words";

/**
 * MAP-2: the editor's checked-hours form, part of a place change. Works without
 * JavaScript and by keyboard. Up to two periods a day; "past midnight" for a period that
 * ends after 12 AM; "Open 24 hours" for the whole day; up to three dated changes.
 * Nothing is published until a different publisher approves the whole change.
 */
const ORDER = [1, 2, 3, 4, 5, 6, 0];
export const EXCEPTION_ROWS = 3;

export function HoursFields({ draft, current }: { draft: WeeklyHours | null; current: WeeklyHours | null }) {
  const start = draft ?? current;
  const periods = (d: number) => (start?.weekly ?? []).filter((p) => p.day === d).sort((a, b) => a.opens.localeCompare(b.opens));
  const exceptions = start?.exceptions ?? [];
  return (
    <fieldset className="panel" data-testid="hours-fields">
      <legend className="h-sec" style={{ marginTop: 0 }}>4. Checked opening hours</legend>
      <p className="s14 muted" style={{ marginTop: 0 }}>
        Enter the hours exactly as the source in step 1 gives them, in the place&rsquo;s local time. Leave a day empty if it is closed.
        A period that ends after midnight needs &ldquo;past midnight&rdquo; ticked. Hours stay checked for 60 days; after that the place shows
        &ldquo;Hours need confirmation&rdquo; and never appears under &ldquo;Open now&rdquo;.
      </p>
      <label className="check">
        <input type="checkbox" name="hoursOn" value="1" defaultChecked={draft !== null} data-testid="hours-on" />
        <span>
          Include checked opening hours in this change
          <span className="hint">
            {current ? "Filled in with the hours checked last time. Tick this to confirm them again or to change them." : "This place has no checked hours yet."}
          </span>
        </span>
      </label>
      <table className="hours-table hours-edit">
        <caption className="sr-only">Weekly opening hours</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">First period</th>
            <th scope="col">Second period (optional)</th>
            <th scope="col">All day</th>
          </tr>
        </thead>
        <tbody>
          {ORDER.map((d) => {
            const ps = periods(d);
            const allDay = ps.length === 1 && ps[0].opens === "00:00" && ps[0].closes === "00:00" && ps[0].closesNextDay;
            return (
              <tr key={d}>
                <th scope="row">{DAY_NAMES[d]}</th>
                {[0, 1].map((slot) => {
                  const p = allDay ? undefined : ps[slot];
                  const id = `h_${d}_${slot}`;
                  return (
                    <td key={slot}>
                      <span className="hours-slot">
                        <label htmlFor={`${id}_opens`} className="sr-only">{`${DAY_NAMES[d]} ${slot === 0 ? "first" : "second"} period opens`}</label>
                        <input id={`${id}_opens`} name={`${id}_opens`} type="time" defaultValue={p?.opens ?? ""} />
                        <span aria-hidden="true">to</span>
                        <label htmlFor={`${id}_closes`} className="sr-only">{`${DAY_NAMES[d]} ${slot === 0 ? "first" : "second"} period closes`}</label>
                        <input id={`${id}_closes`} name={`${id}_closes`} type="time" defaultValue={p?.closes ?? ""} />
                        <label className="check inline">
                          <input type="checkbox" name={`${id}_next`} value="1" defaultChecked={p?.closesNextDay ?? false} />
                          <span>past midnight</span>
                        </label>
                      </span>
                    </td>
                  );
                })}
                <td>
                  <label className="check inline">
                    <input type="checkbox" name={`h_${d}_allday`} value="1" defaultChecked={allDay} />
                    <span>
                      Open 24 hours<span className="sr-only"> on {DAY_NAMES[d]}</span>
                    </span>
                  </label>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <h3 className="s14" style={{ margin: "12px 0 4px" }}>Dated changes (optional)</h3>
      <p className="s13 muted" style={{ margin: 0 }}>Holidays, special hours on one date, or a temporary closure. A dated change replaces the weekly hours on its dates.</p>
      {Array.from({ length: EXCEPTION_ROWS }, (_, i) => {
        const e = exceptions[i];
        return (
          <div className="field-grid" key={i} style={{ marginTop: 8 }}>
            <div>
              <label htmlFor={`x_${i}_from`}>Change {i + 1}: from</label>
              <input id={`x_${i}_from`} name={`x_${i}_from`} type="date" defaultValue={e?.startsOn ?? ""} />
            </div>
            <div>
              <label htmlFor={`x_${i}_to`}>to (same day if empty)</label>
              <input id={`x_${i}_to`} name={`x_${i}_to`} type="date" defaultValue={e && e.endsOn !== e.startsOn ? e.endsOn : ""} />
            </div>
            <div>
              <label htmlFor={`x_${i}_kind`}>What happens</label>
              <select id={`x_${i}_kind`} name={`x_${i}_kind`} defaultValue={e?.kind ?? "closed"}>
                <option value="closed">Closed that day</option>
                <option value="special_hours">Special hours</option>
                <option value="temporary_closure">Temporarily closed</option>
              </select>
            </div>
            <div>
              <label htmlFor={`x_${i}_opens`}>Special hours (if chosen)</label>
              <span className="hours-slot">
                <input id={`x_${i}_opens`} name={`x_${i}_opens`} type="time" defaultValue={e?.opens ?? ""} aria-label={`Change ${i + 1} opens`} />
                <span aria-hidden="true">to</span>
                <input id={`x_${i}_closes`} name={`x_${i}_closes`} type="time" defaultValue={e?.closes ?? ""} aria-label={`Change ${i + 1} closes`} />
                <label className="check inline">
                  <input type="checkbox" name={`x_${i}_next`} value="1" defaultChecked={e?.closesNextDay ?? false} />
                  <span>past midnight</span>
                </label>
              </span>
            </div>
            <div>
              <label htmlFor={`x_${i}_reason`}>Reason shown to visitors (optional)</label>
              <input id={`x_${i}_reason`} name={`x_${i}_reason`} type="text" maxLength={120} defaultValue={e?.reason ?? ""} autoComplete="off" />
            </div>
          </div>
        );
      })}
    </fieldset>
  );
}

/** Reads the form above into the shape the database checks (app.clean_hours). Empty rows are skipped. */
export function hoursFromForm(get: (name: string) => string | undefined): WeeklyHours {
  const weekly: WeeklyHours["weekly"] = [];
  for (const d of ORDER) {
    if (get(`h_${d}_allday`) === "1") {
      weekly.push({ day: d, opens: "00:00", closes: "00:00", closesNextDay: true });
      continue;
    }
    for (const slot of [0, 1]) {
      const opens = get(`h_${d}_${slot}_opens`);
      const closes = get(`h_${d}_${slot}_closes`);
      if (!opens && !closes) continue;
      weekly.push({ day: d, opens: opens ?? "", closes: closes ?? "", closesNextDay: get(`h_${d}_${slot}_next`) === "1" });
    }
  }
  const exceptions: WeeklyHours["exceptions"] = [];
  for (let i = 0; i < EXCEPTION_ROWS; i++) {
    const from = get(`x_${i}_from`);
    if (!from) continue;
    const kind = (["closed", "special_hours", "temporary_closure"] as const).find((k) => k === get(`x_${i}_kind`)) ?? "closed";
    exceptions.push({
      startsOn: from,
      endsOn: get(`x_${i}_to`) ?? from,
      kind,
      opens: kind === "special_hours" ? (get(`x_${i}_opens`) ?? null) : null,
      closes: kind === "special_hours" ? (get(`x_${i}_closes`) ?? null) : null,
      closesNextDay: kind === "special_hours" && get(`x_${i}_next`) === "1",
      reason: get(`x_${i}_reason`) ?? null,
    });
  }
  return { weekly, exceptions };
}
