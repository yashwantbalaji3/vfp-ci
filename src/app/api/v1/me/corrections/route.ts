import { getMyCorrections } from "@/server/editor";
import { privateJson } from "@/server/http";
import { socialRoute } from "@/server/social/api";

/** The signed-in member's own corrections and what became of them. Never anyone else's. */
export async function GET(request: Request) {
  return socialRoute(request, async () => privateJson({ corrections: await getMyCorrections() }));
}
