import { deleteEntryInputSchema, updateEntryInputSchema } from "@/contracts/diary";
import { privateJson, statusJson } from "@/server/http";
import { deleteEntry, updateEntry } from "@/server/diary";
import { fieldErrors, memberRoute, readJson } from "@/server/diary/api";

type Ctx = { params: Promise<{ id: string }> };

/** Change the amount, meal or day of one of your entries. `expectedVersion` stops two edits overwriting each other. */
export async function PATCH(request: Request, { params }: Ctx) {
  return memberRoute(request, async () => {
    const body = await readJson(request);
    const input = updateEntryInputSchema.safeParse({ ...(body as object), entryId: (await params).id });
    if (!input.success) return statusJson(422, "INVALID_ENTRY", fieldErrors(input.error));
    return privateJson(await updateEntry(input.data));
  });
}

/** Remove one of your entries: `?expectedVersion=`. It can be restored for 15 minutes. */
export async function DELETE(request: Request, { params }: Ctx) {
  return memberRoute(request, async () => {
    const input = deleteEntryInputSchema.safeParse({
      entryId: (await params).id,
      expectedVersion: new URL(request.url).searchParams.get("expectedVersion"),
    });
    if (!input.success) return statusJson(422, "INVALID_ENTRY", fieldErrors(input.error));
    return privateJson(await deleteEntry(input.data.entryId, input.data.expectedVersion));
  });
}
