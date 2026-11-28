import { z } from "zod";
import { handleSchema } from "@/contracts/social";
import { fieldErrors, readJson } from "@/server/diary/api";
import { privateJson, statusJson } from "@/server/http";
import { getConnections, removeFriend, requestFriend, respondFriend } from "@/server/social";
import { socialRoute } from "@/server/social/api";

/** Your own people: following, followers, friends, requests and blocks. Nobody else can read these lists. */
export async function GET(request: Request) {
  return socialRoute(request, async () => privateJson(await getConnections()));
}

/** Send a friend request: `{ handle }`. */
export async function POST(request: Request) {
  return socialRoute(request, async () => {
    const input = z.object({ handle: handleSchema }).safeParse(await readJson(request));
    if (!input.success) return statusJson(422, "INVALID_REQUEST", fieldErrors(input.error));
    return privateJson(await requestFriend(input.data.handle), { status: 201 });
  });
}

/** Answer a request you received: `{ handle, accept }`. */
export async function PATCH(request: Request) {
  return socialRoute(request, async () => {
    const input = z.object({ handle: handleSchema, accept: z.boolean() }).safeParse(await readJson(request));
    if (!input.success) return statusJson(422, "INVALID_REQUEST", fieldErrors(input.error));
    return privateJson(await respondFriend(input.data.handle, input.data.accept));
  });
}

/** Cancel your request or end a friendship: `?handle=`. */
export async function DELETE(request: Request) {
  return socialRoute(request, async () => {
    const handle = handleSchema.safeParse(new URL(request.url).searchParams.get("handle"));
    if (!handle.success) return statusJson(404, "PROFILE_NOT_FOUND");
    return privateJson(await removeFriend(handle.data));
  });
}
