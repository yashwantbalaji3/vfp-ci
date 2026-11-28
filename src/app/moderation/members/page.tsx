import { Suspense } from "react";
import { redirect } from "next/navigation";
import { handleSchema } from "@/contracts/social";
import type { RawParams } from "@/lib/search-params";

export const metadata = { title: "Member history", robots: { index: false, follow: false } };

/** Takes the handle typed into the look-up box on the moderation page and opens that member's history. */
async function Go({ searchParams }: { searchParams: Promise<RawParams> }) {
  const sp = await searchParams;
  const raw = Array.isArray(sp.handle) ? sp.handle[0] : sp.handle;
  const handle = handleSchema.safeParse((raw ?? "").trim().replace(/^@/, "").toLowerCase());
  redirect(handle.success ? `/moderation/members/${handle.data}` : "/moderation?e=MEMBER_NOT_FOUND");
  return null;
}

export default function MemberLookupPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  return (
    <Suspense fallback={null}>
      <Go searchParams={searchParams} />
    </Suspense>
  );
}
