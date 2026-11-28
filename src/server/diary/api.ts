import "server-only";
import { connection } from "next/server";
import type { z } from "zod";
import { getCurrentMember, type CurrentMember } from "@/server/auth/session";
import { limitRefusal, statusJson } from "@/server/http";
import { checkRateLimit } from "@/server/rate-limit";
import { DiaryError } from "@/server/diary";

/**
 * Shared wrapper for the private diary and goals routes (docs/09, docs/11).
 * Order: rate limit, then same-site check for anything that changes data, then a
 * verified session. Responses are always `private, no-store`. Errors never echo
 * the request, so no diary text or numbers can reach the logs.
 */
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** A browser on another site can't forge these: the Origin must be ours, and the body must be JSON. */
export function isSameOriginWrite(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
      if (new URL(origin).host !== host) return false;
    } catch {
      return false;
    }
  } else if (request.headers.get("sec-fetch-site") && request.headers.get("sec-fetch-site") !== "same-origin") {
    return false;
  }
  const hasBody = request.method !== "DELETE";
  return !hasBody || (request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json");
}

export async function memberRoute(request: Request, run: (member: CurrentMember) => Promise<Response>): Promise<Response> {
  await connection();
  try {
    const refused = limitRefusal(await checkRateLimit(request, "member"));
    if (refused) return refused;
    if (WRITE_METHODS.has(request.method) && !isSameOriginWrite(request)) return statusJson(403, "CROSS_SITE_REQUEST");
    const member = await getCurrentMember();
    if (!member) return statusJson(401, "NOT_SIGNED_IN");
    return await run(member);
  } catch (e) {
    if (e instanceof DiaryError) return statusJson(e.status, e.code);
    console.error("diary_route_error", e instanceof Error ? e.name : "unknown");
    return statusJson(500, "DIARY_UNAVAILABLE");
  }
}

export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) out[issue.path.join(".") || "request"] ??= issue.message;
  return out;
}

/** Reads a JSON body of at most 16 KB. Anything else is an invalid request, not a crash. */
export async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > 16384) throw new DiaryError(422, "BODY_TOO_LARGE");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new DiaryError(422, "INVALID_JSON");
  }
}
