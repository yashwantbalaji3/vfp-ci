import "server-only";
import {
  claimTargetSchema, claimsOverviewSchema, decisionResultSchema, idSchema, licenceSchema, myClaimsSchema, queueSchema, stateResultSchema, submitResultSchema,
} from "@/contracts/partner";
import { rpc } from "@/server/social";

/**
 * Restaurant submissions (docs/48). Every call runs as the signed-in person; the database decides who may
 * do what (claimant only, moderator only, never one's own claim or place) and keeps everything
 * permanently. No privileged key is used, and nothing here publishes anything.
 */
export const getClaimTarget = (candidateId: string) => rpc("partner_claim_target", { p_candidate: candidateId }, claimTargetSchema);
export const createClaim = (candidateId: string, roleTitle: string, email: string) =>
  rpc("partner_create_claim", { p_candidate: candidateId, p_role_title: roleTitle, p_email: email }, idSchema);
export const getMyClaims = () => rpc("partner_my_claims", {}, myClaimsSchema);
export const getLicence = () => rpc("partner_licence", {}, licenceSchema);
export const submitMenu = (claimId: string, licence: string, fileName: string, sha256: string, documentDate: string | null, items: unknown[]) =>
  rpc("partner_submit_menu", { p_claim: claimId, p_licence: licence, p_file_name: fileName, p_file_sha256: sha256, p_document_date: documentDate, p_items: items }, submitResultSchema);
export const withdrawClaim = (claimId: string, reason: string | null) => rpc("partner_withdraw", { p_claim: claimId, p_reason: reason }, stateResultSchema);
export const getClaimsOverview = () => rpc("partner_claims_overview", {}, claimsOverviewSchema);
export const recordCheck = (claimId: string, method: string, outcome: string, evidence: string) =>
  rpc("partner_record_check", { p_claim: claimId, p_method: method, p_outcome: outcome, p_evidence: evidence }, stateResultSchema);
export const getModerationQueue = () => rpc("partner_moderation_queue", {}, queueSchema);
export const reviewDish = (itemId: string, decision: string, note: string | null) =>
  rpc("partner_review_item", { p_item: itemId, p_decision: decision, p_note: note }, decisionResultSchema);
