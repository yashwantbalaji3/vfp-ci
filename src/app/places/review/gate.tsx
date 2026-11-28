import "server-only";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { getCurrentMember } from "@/server/auth/session";
import { SocialError } from "@/server/social";

/**
 * Founder pages answer an ordinary signed-in member with the plain "not found" page instead of the founder page
 * frame (journey L, 24 Nov 2026). The probe is the page's own founder-only read; the database still refuses
 * everyone else, so this only changes what a member sees. Signed-out visitors keep the sign-in prompt.
 */
export async function notFoundUnlessFounder(probe: () => Promise<unknown>) {
  if (!(await getCurrentMember())) return;
  try {
    await probe();
  } catch (e) {
    if (e instanceof SocialError && (e.status === 403 || e.status === 401))
      notFound();
  }
}

/** Renders its children only once the founder check has passed; place it inside a Suspense boundary. */
export async function FounderGate({
  probe,
  children,
}: {
  probe: () => Promise<unknown>;
  children: ReactNode;
}) {
  await notFoundUnlessFounder(probe);
  return children;
}
