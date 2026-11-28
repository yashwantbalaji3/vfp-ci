import type { ReviewItem } from "@/contracts/review";
import { precheckIdentity } from "../../scripts/lib/identity-precheck.mjs";

/**
 * What the automatic checks found about one place, in plain sentences for the founder (docs/33).
 * Pure: it only reads the evidence snapshot. "ok" means the check found nothing worrying; it never
 * means the identity is verified.
 */
export type Check = { ok: boolean; text: string };

/** Every automatic check on one place (docs/33, docs/51). The rules live in scripts/lib/identity-precheck.mjs, which the build also uses. */
export function evidenceChecks(item: ReviewItem): Check[] {
  return precheckIdentity(item.evidence).points.map(({ ok, text }) => ({ ok, text }));
}

/** "agree" when every automatic check found nothing worrying; "look" otherwise. Never a verification. */
export function precheckLevel(item: ReviewItem): "agree" | "look" {
  return precheckIdentity(item.evidence).level;
}

/** A link to the place on OpenStreetMap, for a look at the street map and nearby businesses. */
export const osmLink = (lat: number, lon: number) => `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=19/${lat}/${lon}`;
