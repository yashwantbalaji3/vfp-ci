import { isoDateSchema } from "@/contracts/diary";
import { privateJson, statusJson } from "@/server/http";
import { getDiaryDay } from "@/server/diary";
import { memberRoute } from "@/server/diary/api";
import { memberClock } from "@/server/diary/clock";

/** One day of the signed-in member's own diary. `?date=YYYY-MM-DD`, default today in their timezone. */
export async function GET(request: Request) {
  return memberRoute(request, async () => {
    const raw = new URL(request.url).searchParams.get("date");
    const date = raw === null ? (await memberClock()).today : isoDateSchema.safeParse(raw).data;
    if (!date) return statusJson(422, "INVALID_DATE", { date: "Use a date like 2026-11-14" });
    return privateJson(await getDiaryDay(date));
  });
}
