import { z } from "zod";
import { handleSchema } from "@/contracts/social";
import { fieldErrors, readJson } from "@/server/diary/api";
import { getMemberHistory, setMemberSuspension } from "@/server/editor";
import { privateJson, statusJson } from "@/server/http";
import { socialRoute } from "@/server/social/api";

/** Moderators only: counts and past decisions about one member's public content. Nothing private. */
export async function GET(request: Request, { params }: { params: Promise<{ handle: string }> }) {
  return socialRoute(request, async () => {
    const handle = handleSchema.safeParse((await params).handle);
    if (!handle.success) return statusJson(404, "MEMBER_NOT_FOUND");
    return privateJson(await getMemberHistory(handle.data));
  });
}

/** Moderators only: `{ suspend: true, reason }` or `{ suspend: false, reason? }`. */
export async function POST(request: Request, { params }: { params: Promise<{ handle: string }> }) {
  return socialRoute(request, async () => {
    const handle = handleSchema.safeParse((await params).handle);
    if (!handle.success) return statusJson(404, "MEMBER_NOT_FOUND");
    const input = z.object({ suspend: z.boolean(), reason: z.string().trim().max(300).optional() }).safeParse(await readJson(request));
    if (!input.success) return statusJson(422, "INVALID_ACTION", fieldErrors(input.error));
    return privateJson(await setMemberSuspension(handle.data, input.data.suspend, input.data.reason));
  });
}
