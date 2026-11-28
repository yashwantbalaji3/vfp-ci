import { diaryCsv, type ExportEntry } from "@/domain/diary/export";
import { exportMyData } from "@/server/diary";
import { memberRoute } from "@/server/diary/api";

const HEADERS = { "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff" };

/** The signed-in member's own data: `?format=json` (everything) or `?format=csv` (diary entries). */
export async function GET(request: Request) {
  return memberRoute(request, async () => {
    const format = new URL(request.url).searchParams.get("format") === "csv" ? "csv" : "json";
    const data = await exportMyData();
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === "csv") {
      return new Response(diaryCsv((data.diaryEntries ?? []) as ExportEntry[]), {
        headers: { ...HEADERS, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="food-diary-${stamp}.csv"` },
      });
    }
    return new Response(JSON.stringify(data, null, 2), {
      headers: { ...HEADERS, "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="my-data-${stamp}.json"` },
    });
  });
}
