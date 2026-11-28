import { z } from "zod";
import { privateJson, statusJson } from "@/server/http";
import { restoreEntry } from "@/server/diary";
import { memberRoute, readJson } from "@/server/diary/api";

/** Undo a delete within 15 minutes. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return memberRoute(request, async () => {
    await readJson(request);
    const id = z.uuid().safeParse((await params).id);
    if (!id.success) return statusJson(422, "INVALID_ENTRY");
    return privateJson(await restoreEntry(id.data));
  });
}
