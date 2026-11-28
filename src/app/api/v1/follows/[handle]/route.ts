import { handleSchema } from "@/contracts/social";
import { privateJson, statusJson } from "@/server/http";
import { follow, unfollow } from "@/server/social";
import { socialRoute } from "@/server/social/api";

type Ctx = { params: Promise<{ handle: string }> };

export async function PUT(request: Request, ctx: Ctx) {
  return socialRoute(request, async () => {
    const handle = handleSchema.safeParse((await ctx.params).handle);
    if (!handle.success) return statusJson(404, "PROFILE_NOT_FOUND");
    await follow(handle.data);
    return privateJson({ following: true });
  });
}

export async function DELETE(request: Request, ctx: Ctx) {
  return socialRoute(request, async () => {
    const handle = handleSchema.safeParse((await ctx.params).handle);
    if (!handle.success) return statusJson(404, "PROFILE_NOT_FOUND");
    await unfollow(handle.data);
    return privateJson({ following: false });
  });
}
