import { handleSchema } from "@/contracts/social";
import { privateJson, statusJson } from "@/server/http";
import { blockUser, unblockUser } from "@/server/social";
import { socialRoute } from "@/server/social/api";

type Ctx = { params: Promise<{ handle: string }> };

/** Blocking ends following and friendship in both directions. The other person is not told. */
export async function PUT(request: Request, ctx: Ctx) {
  return socialRoute(request, async () => {
    const handle = handleSchema.safeParse((await ctx.params).handle);
    if (!handle.success) return statusJson(404, "PROFILE_NOT_FOUND");
    await blockUser(handle.data);
    return privateJson({ blocked: true });
  });
}

export async function DELETE(request: Request, ctx: Ctx) {
  return socialRoute(request, async () => {
    const handle = handleSchema.safeParse((await ctx.params).handle);
    if (!handle.success) return statusJson(404, "PROFILE_NOT_FOUND");
    await unblockUser(handle.data);
    return privateJson({ blocked: false });
  });
}
