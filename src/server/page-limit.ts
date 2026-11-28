import "server-only";
import { headers } from "next/headers";
import { checkActionLimit, type LimitOutcome } from "@/server/rate-limit";

/**
 * Page requests that run a search are limited per visitor address (docs/14 PH-01 test 3).
 *
 * The check lives in the part of the page that does the searching, not in the request
 * proxy, for a measured reason: the framework quietly prefetches every visible link (about
 * twenty requests per page viewed) and removes the marker that identifies those requests
 * before the proxy sees them, so a proxy count would refuse ordinary visitors. Prefetches
 * are answered from the prebuilt page frame and never reach this code, so only real page
 * views that query the database are counted, and no request header can be forged to skip it.
 *
 * "limited" means this address asked too often; "unavailable" means the counter could not be
 * checked. Both refuse the search (fail closed); pages say which one happened (limitNotice).
 */
export async function pageLimit(): Promise<LimitOutcome> {
  return checkActionLimit(await headers(), "page");
}
