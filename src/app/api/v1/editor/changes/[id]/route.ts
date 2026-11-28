import { z } from "zod";
import { idSchema } from "@/contracts/catalog";
import { fieldErrors, readJson } from "@/server/diary/api";
import { getChange, reviewChange, submitChange, withdrawChange } from "@/server/editor";
import { privateJson, statusJson } from "@/server/http";
import { socialRoute } from "@/server/social/api";

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("submit") }),
  z.object({ action: z.literal("withdraw") }),
  z.object({ action: z.literal("approve"), note: z.string().trim().max(300).optional(), sourceChecked: z.boolean(), rightsOk: z.boolean() }),
  z.object({ action: z.literal("reject"), note: z.string().trim().min(3).max(300) }),
]);

/** One catalog change, for catalog editors only: source, both versions, and its record. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return socialRoute(request, async () => {
    const id = idSchema.safeParse((await params).id);
    if (!id.success) return statusJson(404, "CHANGE_NOT_FOUND");
    return privateJson(await getChange(id.data));
  });
}

/**
 * One step on a change: `{ action: submit | withdraw }` by its author, or
 * `{ action: approve, sourceChecked, rightsOk, note? }` / `{ action: reject, note }`
 * by a different person who holds the publisher role. The database refuses an
 * approval by the author.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return socialRoute(request, async () => {
    const id = idSchema.safeParse((await params).id);
    if (!id.success) return statusJson(404, "CHANGE_NOT_FOUND");
    const input = actionSchema.safeParse(await readJson(request));
    if (!input.success) return statusJson(422, "INVALID_ACTION", fieldErrors(input.error));
    const a = input.data;
    if (a.action === "submit") return privateJson(await submitChange(id.data));
    if (a.action === "withdraw") return privateJson(await withdrawChange(id.data));
    if (a.action === "approve") return privateJson(await reviewChange(id.data, "approve", a.note, a.sourceChecked, a.rightsOk));
    return privateJson(await reviewChange(id.data, "reject", a.note, false, false));
  });
}
