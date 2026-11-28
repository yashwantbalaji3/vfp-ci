import { z } from "zod";
import { idSchema } from "@/contracts/catalog";
import { moderateInputSchema } from "@/contracts/social";
import { fieldErrors, readJson } from "@/server/diary/api";
import { privateJson, statusJson } from "@/server/http";
import { dismissReports, getModerationQueue, moderate } from "@/server/social";
import { socialRoute } from "@/server/social/api";

/** Moderators only (the database checks the role): waiting posts, open reports, removed items and recent decisions. */
export async function GET(request: Request) {
  return socialRoute(request, async () => privateJson(await getModerationQueue()));
}

/** One decision: `{ type, id, action: approve|remove|restore, reason? }` or `{ dismissReportId, reason? }`. */
export async function POST(request: Request) {
  return socialRoute(request, async () => {
    const body = await readJson(request);
    const dismiss = z.object({ dismissReportId: idSchema, reason: z.string().trim().max(300).optional() }).safeParse(body);
    if (dismiss.success) return privateJson(await dismissReports(dismiss.data.dismissReportId, dismiss.data.reason));
    const input = moderateInputSchema.safeParse(body);
    if (!input.success) return statusJson(422, "INVALID_DECISION", fieldErrors(input.error));
    return privateJson(await moderate(input.data));
  });
}
