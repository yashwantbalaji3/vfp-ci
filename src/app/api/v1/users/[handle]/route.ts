import { handleSchema } from "@/contracts/social";
import { readDietPreference } from "@/server/catalog/diet";
import { privateJson, statusJson } from "@/server/http";
import { getProfile } from "@/server/social";
import { socialRoute } from "@/server/social/api";

/** A profile as the caller may see it: `?view=needs_confirmation` for the opt-in group. */
export async function GET(request: Request, ctx: { params: Promise<{ handle: string }> }) {
  return socialRoute(
    request,
    async () => {
      const handle = handleSchema.safeParse((await ctx.params).handle);
      if (!handle.success) return statusJson(404, "PROFILE_NOT_FOUND");
      const view = new URL(request.url).searchParams.get("view") === "needs_confirmation" ? "needs_confirmation" : "matches";
      return privateJson(await getProfile(handle.data, view, await readDietPreference()));
    },
    { guestCanRead: true },
  );
}
