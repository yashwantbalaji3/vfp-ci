import { privateJson } from "@/server/http";
import { publishRanking, withdrawRanking } from "@/server/social";
import { socialRoute } from "@/server/social/api";

/** Publish a fixed copy of the current private order. */
export async function POST(request: Request) {
  return socialRoute(request, async () => privateJson(await publishRanking(), { status: 201 }));
}

/** Withdraw the published copy. The private order is untouched. */
export async function DELETE(request: Request) {
  return socialRoute(request, async () => privateJson(await withdrawRanking()));
}
