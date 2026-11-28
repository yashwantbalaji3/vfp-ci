import { reportInputSchema } from "@/contracts/social";
import { fieldErrors, readJson } from "@/server/diary/api";
import { privateJson, statusJson } from "@/server/http";
import { reportContent } from "@/server/social";
import { socialRoute } from "@/server/social/api";

/** Report a review, list, ranking or profile you can see. The person is not told who reported it. */
export async function POST(request: Request) {
  return socialRoute(request, async () => {
    const input = reportInputSchema.safeParse(await readJson(request));
    if (!input.success) return statusJson(422, "INVALID_REPORT", fieldErrors(input.error));
    await reportContent(input.data);
    return privateJson({ reported: true }, { status: 201 });
  });
}
