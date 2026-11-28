import "server-only";
import { connection } from "next/server";
import { FLAGS } from "@/config/flags";
import { getCurrentMember, type CurrentMember } from "@/server/auth/session";
import { isSameOriginWrite } from "@/server/diary/api";
import { DiaryError } from "@/server/diary";
import { limitRefusal, statusJson } from "@/server/http";
import { checkRateLimit } from "@/server/rate-limit";
import { SocialError } from "@/server/social";

/**
 * Shared wrapper for the social routes (docs/09, docs/11). Order: rate limit,
 * same-site check for anything that changes data, then the session. A guest may
 * read approved public content only where the route says so AND public social
 * reading has been switched on; every write needs a member. Responses are always
 * `private, no-store`, and errors never echo what was sent.
 */
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export async function socialRoute(
  request: Request,
  run: (member: CurrentMember | null) => Promise<Response>,
  opts: { guestCanRead?: boolean } = {},
): Promise<Response> {
  await connection();
  try {
    const write = WRITE_METHODS.has(request.method);
    const refused = limitRefusal(await checkRateLimit(request, write ? "socialWrite" : "socialRead", "social"));
    if (refused) return refused;
    if (write && !isSameOriginWrite(request)) return statusJson(403, "CROSS_SITE_REQUEST");
    const member = await getCurrentMember();
    if (!member && (write || !opts.guestCanRead || !FLAGS.socialPublicEnabled)) return statusJson(401, "NOT_SIGNED_IN");
    return await run(member);
  } catch (e) {
    if (e instanceof SocialError || e instanceof DiaryError) return statusJson(e.status, e.code);
    console.error("social_route_error", e instanceof Error ? e.name : "unknown");
    return statusJson(500, "SOCIAL_UNAVAILABLE");
  }
}
