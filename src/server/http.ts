import "server-only";
import { randomUUID } from "node:crypto";

/** Every private response is uncacheable by browsers and shared caches (docs/11). */
const PRIVATE_HEADERS = { "Cache-Control": "private, no-store", Vary: "Cookie" };

export function privateJson<T>(data: T, init?: { status?: number; nextCursor?: string | null }) {
  return Response.json(
    { data, meta: { requestId: randomUUID(), nextCursor: init?.nextCursor ?? null } },
    { status: init?.status ?? 200, headers: PRIVATE_HEADERS },
  );
}

export function errorJson(status: number, code: string, message: string, fields?: Record<string, string>) {
  return Response.json(
    { error: { code, message, ...(fields ? { fields } : {}), requestId: randomUUID() } },
    { status, headers: PRIVATE_HEADERS },
  );
}

/**
 * Catalog responses are public facts, but they can vary with the visitor's own
 * dietary filter and with a location sent in the request, so they are not shared
 * from a cache either.
 */
export function catalogJson<T>(data: T, init?: { nextOffset?: number | null }) {
  return Response.json(
    { data, meta: { requestId: randomUUID(), nextOffset: init?.nextOffset ?? null } },
    { status: 200, headers: PRIVATE_HEADERS },
  );
}

const MESSAGES: Record<number, string> = {
  401: "Sign in to continue.",
  403: "That request isn't allowed.",
  404: "We couldn't find that.",
  409: "This changed somewhere else. Reload and try again.",
  422: "Something in that request isn't valid.",
  429: "Too many requests. Please wait a minute and try again.",
  500: "Something went wrong on our side. Please try again.",
  503: "This is temporarily unavailable. Please try again shortly.",
};

export function statusJson(status: 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503, code: string, fields?: Record<string, string>) {
  const res = errorJson(status, code, MESSAGES[status], fields);
  if (status === 429) res.headers.set("Retry-After", "60");
  return res;
}

/**
 * The refusal for a request limit: 429 when the caller asked too often, 503 when the counter
 * could not be checked (still refused: fail closed). Null when the request may go ahead.
 */
export function limitRefusal(outcome: "ok" | "limited" | "unavailable"): Response | null {
  if (outcome === "ok") return null;
  return outcome === "limited" ? statusJson(429, "RATE_LIMITED") : statusJson(503, "LIMITER_UNAVAILABLE");
}
