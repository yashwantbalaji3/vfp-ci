import "server-only";
import { cache } from "react";
import { z } from "zod";
import { menuDecideResultSchema, menuPlaceSchema, menuPlacesSchema } from "@/contracts/menu-review";
import { rpc } from "@/server/social";

/**
 * Founder batch review of drafted real-menu facts (docs/58). Every call runs as the signed-in person;
 * the database refuses anyone but the founder (FOUNDER_ONLY), refuses to let the person who entered a
 * fact confirm it, refuses to confirm a fact whose source is not cleared, and keeps every decision.
 * Nothing here publishes anything. No privileged key is used.
 */
const correctResultSchema = z.object({ factId: z.string().uuid(), status: z.literal("correction_requested") });

export const getMenuPlaces = cache(() => rpc("menu_review_places", {}, menuPlacesSchema));
export const getMenuPlace = (placeId: string) => rpc("menu_review_place", { p_place: placeId }, menuPlaceSchema);
export const decideMenuFacts = (decisions: { factId: string; decision: "verify" | "reject" | "confirm_transcription"; note?: string }[]) =>
  rpc("menu_review_decide", { p_decisions: decisions }, menuDecideResultSchema);
export const correctMenuFact = (factId: string, value: Record<string, unknown>, note?: string) =>
  rpc("menu_review_correct", { p_fact: factId, p_value: value, p_note: note || null }, correctResultSchema);
