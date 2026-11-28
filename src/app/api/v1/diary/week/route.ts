import { isoDateSchema } from "@/contracts/diary";
import { weekDates } from "@/domain/dates/week";
import { summarizeWeek } from "@/domain/diary/summary";
import { privateJson, statusJson } from "@/server/http";
import { getDiaryWeek } from "@/server/diary";
import { memberRoute } from "@/server/diary/api";
import { memberClock } from "@/server/diary/clock";

/** The Monday-start week containing `?date=` (default today), with the summary the week screen shows. */
export async function GET(request: Request) {
  return memberRoute(request, async () => {
    const clock = await memberClock();
    const raw = new URL(request.url).searchParams.get("date");
    const date = raw === null ? clock.today : isoDateSchema.safeParse(raw).data;
    if (!date) return statusJson(422, "INVALID_DATE", { date: "Use a date like 2026-11-14" });
    const week = await getDiaryWeek(weekDates(date)[0]);
    return privateJson({ ...week, summary: summarizeWeek(week.days, clock.today) });
  });
}
