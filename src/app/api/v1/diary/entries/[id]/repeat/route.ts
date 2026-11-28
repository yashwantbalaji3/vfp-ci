import { repeatEntryInputSchema } from "@/contracts/diary";
import { privateJson, statusJson } from "@/server/http";
import { repeatEntry } from "@/server/diary";
import { fieldErrors, memberRoute, readJson } from "@/server/diary/api";
import { memberClock } from "@/server/diary/clock";

/** Log one of your past entries again on another day. The original entry is not changed. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return memberRoute(request, async () => {
    const body = await readJson(request);
    const input = repeatEntryInputSchema.safeParse({ ...(body as object), entryId: (await params).id });
    if (!input.success) return statusJson(422, "INVALID_ENTRY", fieldErrors(input.error));
    const result = await repeatEntry(input.data, (await memberClock()).timeZone);
    return privateJson(result, { status: result.replayed ? 200 : 201 });
  });
}
