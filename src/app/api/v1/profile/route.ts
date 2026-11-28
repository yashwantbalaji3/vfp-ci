import { profileInputSchema } from "@/contracts/social";
import { fieldErrors, readJson } from "@/server/diary/api";
import { privateJson, statusJson } from "@/server/http";
import { getMyProfile, saveMyProfile } from "@/server/social";
import { socialRoute } from "@/server/social/api";

/** Your own profile settings, including the switches for what others can see. */
export async function GET(request: Request) {
  return socialRoute(request, async () => privateJson(await getMyProfile()));
}

export async function PUT(request: Request) {
  return socialRoute(request, async () => {
    const input = profileInputSchema.safeParse(await readJson(request));
    if (!input.success) return statusJson(422, "INVALID_PROFILE", fieldErrors(input.error));
    await saveMyProfile(input.data);
    return privateJson(await getMyProfile());
  });
}
