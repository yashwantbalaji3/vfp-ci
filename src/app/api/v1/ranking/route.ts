import { z } from "zod";
import { idSchema } from "@/contracts/catalog";
import { fieldErrors, readJson } from "@/server/diary/api";
import { privateJson, statusJson } from "@/server/http";
import { getMyRanking, setRanking } from "@/server/social";
import { socialRoute } from "@/server/social/api";

/** Your private restaurant order, the reviewed restaurants not yet ranked, and the published copy if any. */
export async function GET(request: Request) {
  return socialRoute(request, async () => privateJson(await getMyRanking()));
}

/** Replace the private order: `{ venueIds: [...] }`. Only restaurants you have reviewed. */
export async function PUT(request: Request) {
  return socialRoute(request, async () => {
    const input = z.object({ venueIds: z.array(idSchema).max(200) }).safeParse(await readJson(request));
    if (!input.success) return statusJson(422, "INVALID_RANKING", fieldErrors(input.error));
    await setRanking(input.data.venueIds);
    return privateJson(await getMyRanking());
  });
}
