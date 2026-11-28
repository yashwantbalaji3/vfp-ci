import { z } from "zod";
import { idSchema } from "@/contracts/catalog";
import { listInputSchema, listItemsInputSchema } from "@/contracts/social";
import { readDietPreference } from "@/server/catalog/diet";
import { fieldErrors, readJson } from "@/server/diary/api";
import { privateJson, statusJson } from "@/server/http";
import { deleteList, getEditorialCollections, getList, getMyLists, publishList, saveList, setListItems, unpublishList } from "@/server/social";
import { socialRoute } from "@/server/social/api";

/**
 * `?id=`: one list as the caller may see it (`&view=needs_confirmation` or, for
 * the owner, `&view=manage`). `?editorial=1`: the team's collections. Otherwise: your own lists.
 */
export async function GET(request: Request) {
  const sp = new URL(request.url).searchParams;
  const open = sp.has("id") || sp.has("editorial");
  return socialRoute(
    request,
    async (member) => {
      if (sp.has("editorial")) return privateJson({ collections: await getEditorialCollections() });
      if (!sp.has("id")) return member ? privateJson({ lists: await getMyLists() }) : statusJson(401, "NOT_SIGNED_IN");
      const id = idSchema.safeParse(sp.get("id"));
      if (!id.success) return statusJson(404, "LIST_NOT_FOUND");
      const v = sp.get("view");
      const view = v === "needs_confirmation" || v === "manage" ? v : "matches";
      return privateJson(await getList(id.data, view, await readDietPreference()));
    },
    { guestCanRead: open },
  );
}

/** Create a private list: `{ title, description? }`. */
export async function POST(request: Request) {
  return socialRoute(request, async () => {
    const input = listInputSchema.omit({ listId: true }).safeParse(await readJson(request));
    if (!input.success) return statusJson(422, "INVALID_LIST", fieldErrors(input.error));
    return privateJson(await saveList(input.data), { status: 201 });
  });
}

const patchSchema = z.object({
  listId: idSchema,
  title: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).optional(),
  items: listItemsInputSchema.optional(),
  visibility: z.enum(["private", "public"]).optional(),
});

/** Change one of your lists: its title, its ordered items, or whether it is public. */
export async function PATCH(request: Request) {
  return socialRoute(request, async () => {
    const input = patchSchema.safeParse(await readJson(request));
    if (!input.success) return statusJson(422, "INVALID_LIST", fieldErrors(input.error));
    const { listId, title, description, items, visibility } = input.data;
    if (title !== undefined) await saveList({ listId, title, description });
    if (items !== undefined) await setListItems(listId, items);
    let state: string | undefined;
    if (visibility === "public") state = (await publishList(listId)).state;
    if (visibility === "private") {
      await unpublishList(listId);
      state = "draft";
    }
    return privateJson({ listId, ...(state ? { state } : {}) });
  });
}

export async function DELETE(request: Request) {
  return socialRoute(request, async () => {
    const id = idSchema.safeParse(new URL(request.url).searchParams.get("id"));
    if (!id.success) return statusJson(404, "LIST_NOT_FOUND");
    await deleteList(id.data);
    return privateJson({ deleted: true });
  });
}
