import { z } from "zod";
import { idSchema } from "@/contracts/catalog";
import { AUDIENCES, reviewInputSchema, targetKindSchema } from "@/contracts/social";
import { fieldErrors, readJson } from "@/server/diary/api";
import { privateJson, statusJson } from "@/server/http";
import { deleteReview, getMyReviews, getTargetReviews, saveReview, setReviewAudience } from "@/server/social";
import { socialRoute } from "@/server/social/api";

/**
 * `?kind=venue|food&id=`: the rating summary and reviews of one restaurant or one
 * dish, as the caller may see them. Without those: your own reviews.
 */
export async function GET(request: Request) {
  const sp = new URL(request.url).searchParams;
  const about = sp.has("kind") || sp.has("id");
  return socialRoute(
    request,
    async (member) => {
      if (!about) return member ? privateJson({ reviews: await getMyReviews() }) : statusJson(401, "NOT_SIGNED_IN");
      const kind = targetKindSchema.safeParse(sp.get("kind"));
      const id = idSchema.safeParse(sp.get("id"));
      if (!kind.success || !id.success) return statusJson(404, "TARGET_NOT_FOUND");
      return privateJson(await getTargetReviews(kind.data, id.data));
    },
    { guestCanRead: about },
  );
}

/** Write or update your review of one restaurant or dish. It is private unless `audience` says otherwise. */
export async function POST(request: Request) {
  return socialRoute(request, async () => {
    const input = reviewInputSchema.safeParse(await readJson(request));
    if (!input.success) return statusJson(422, "INVALID_REVIEW", fieldErrors(input.error));
    const saved = await saveReview(input.data);
    const result = saved.audience === input.data.audience && saved.state !== "removed" ? saved : await setReviewAudience(saved.reviewId, input.data.audience);
    return privateJson(result, { status: 201 });
  });
}

/** Change who can see one of your reviews: `{ reviewId, audience }`. */
export async function PATCH(request: Request) {
  return socialRoute(request, async () => {
    const input = z.object({ reviewId: idSchema, audience: z.enum(AUDIENCES) }).safeParse(await readJson(request));
    if (!input.success) return statusJson(422, "INVALID_REVIEW", fieldErrors(input.error));
    return privateJson(await setReviewAudience(input.data.reviewId, input.data.audience));
  });
}

export async function DELETE(request: Request) {
  return socialRoute(request, async () => {
    const id = idSchema.safeParse(new URL(request.url).searchParams.get("id"));
    if (!id.success) return statusJson(404, "REVIEW_NOT_FOUND");
    await deleteReview(id.data);
    return privateJson({ deleted: true });
  });
}
