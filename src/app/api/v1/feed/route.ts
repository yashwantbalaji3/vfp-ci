import { readDietPreference } from "@/server/catalog/diet";
import { privateJson, statusJson } from "@/server/http";
import { getFeed, getRecommendations } from "@/server/social";
import { socialRoute } from "@/server/social/api";

/**
 * `?feed=following` (default) or `?feed=friends`: two separate feeds, never mixed.
 * `?view=needs_confirmation` for the opt-in group; `?before=` for older posts.
 * `?recommendations=1` returns the "rated highly by people you follow" list instead.
 * The caller's own dietary filter always applies.
 */
export async function GET(request: Request) {
  return socialRoute(request, async () => {
    const sp = new URL(request.url).searchParams;
    const view = sp.get("view") === "needs_confirmation" ? "needs_confirmation" : "matches";
    const diet = await readDietPreference();
    if (sp.has("recommendations")) return privateJson(await getRecommendations(view, diet));
    const feed = sp.get("feed") ?? "following";
    if (feed !== "following" && feed !== "friends") return statusJson(422, "INVALID_FEED", { feed: "Use following or friends" });
    const before = sp.get("before");
    if (before && Number.isNaN(Date.parse(before))) return statusJson(422, "INVALID_FEED", { before: "Use a timestamp from nextBefore" });
    const result = await getFeed(feed, view, diet, before ?? undefined);
    return privateJson(result, { nextCursor: result.nextBefore });
  });
}
