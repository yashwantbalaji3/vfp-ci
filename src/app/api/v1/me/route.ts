import { getCurrentMember } from "@/server/auth/session";
import { privateJson, errorJson } from "@/server/http";

/** Minimal identity endpoint used by the cross-user cache test. */
export async function GET() {
  const member = await getCurrentMember();
  if (!member) return errorJson(401, "NOT_SIGNED_IN", "Sign in to continue.");
  return privateJson({ userId: member.id });
}
