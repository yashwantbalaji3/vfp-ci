import "server-only";
import { createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Database-backed request limits (docs/11, docs/12, docs/14 PH-01). In-memory
 * counters do not work on serverless hosting, so the count lives in Postgres.
 *
 * Three rules hold everywhere:
 *  - The network address is never stored or logged. The counter key ("bucket") is
 *    a keyed hash of it, so the table cannot be turned back into a list of visitors.
 *  - Only this server can record a hit: every hit carries RATE_LIMIT_KEY, and the
 *    database checks it against a stored one-way digest.
 *  - If the counter cannot be reached, the request is refused (fail closed).
 */

/** Every limit in one place: how many requests, in how many seconds. */
export const LIMITS = {
  /** Catalog API: search, nearby, protein, detail routes. Per address. */
  catalog: { limit: 60, windowSeconds: 60 },
  /** Social API reads and writes. Per address. */
  socialRead: { limit: 120, windowSeconds: 60 },
  socialWrite: { limit: 60, windowSeconds: 60 },
  /** Private diary, goals, cooking and plan API. Per address. */
  member: { limit: 120, windowSeconds: 60 },
  /** Page requests, which run searches on the server. Per address. */
  page: { limit: 300, windowSeconds: 60 },
  /** Sign-in link requests. Per address and, separately, per email address. */
  signInAddress: { limit: 10, windowSeconds: 600 },
  signInEmail: { limit: 5, windowSeconds: 600 },
  /** Diary, goals, cooking and plan form presses. Per member. */
  memberAction: { limit: 120, windowSeconds: 60 },
  /** Saving or unsaving. Per member. */
  save: { limit: 30, windowSeconds: 60 },
  /** Correction submissions. Per address; the database also caps them per member per day. */
  correction: { limit: 10, windowSeconds: 600 },
} as const;
export type LimitName = keyof typeof LIMITS;

/** Headers a host may guarantee. Anything else in TRUSTED_ADDRESS_HEADER is ignored. */
const ADDRESS_HEADERS = new Set(["x-forwarded-for", "x-real-ip", "x-vercel-forwarded-for", "cf-connecting-ip", "fly-client-ip"]);

function secret(name: "RATE_LIMIT_SALT" | "RATE_LIMIT_KEY", min: number): string {
  const value = process.env[name];
  if (!value || value.length < min) throw new Error(`${name} is not configured`);
  return value;
}

/**
 * The visitor's address, taken ONLY from the one header the host is configured to
 * guarantee (TRUSTED_ADDRESS_HEADER). Any other address header a caller sends is
 * ignored, so forging one cannot earn a fresh allowance. When nothing is configured
 * every caller shares one allowance: stricter, never looser.
 */
export function clientAddress(headers: Headers): string {
  const name = process.env.TRUSTED_ADDRESS_HEADER?.trim().toLowerCase();
  if (!name || !ADDRESS_HEADERS.has(name)) return "unknown";
  const value = headers.get(name)?.split(",")[0]?.trim();
  return value && value.length <= 64 ? value : "unknown";
}

/** `subject` is an address, an email or a member id. Only its keyed hash leaves this function. */
export function bucketFor(scope: string, subject: string): string {
  const digest = createHmac("sha256", secret("RATE_LIMIT_SALT", 16)).update(subject).digest("hex").slice(0, 40);
  // Bucket names are lowercase in the database: "signInEmail" becomes "sign_in_email".
  return `${scope.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}:${digest}`;
}

/** Local browser tests sign the same few people in many times a minute; hosted leaves this unset. */
function scaled(name: LimitName): number {
  const base = LIMITS[name].limit;
  if (name !== "signInAddress" && name !== "signInEmail") return base;
  const scale = Number(process.env.SIGNIN_LIMIT_SCALE);
  return Number.isInteger(scale) && scale >= 1 && scale <= 1000 ? base * scale : base;
}

export type LimitOutcome = "ok" | "limited" | "unavailable";

/** Records one hit. Works with any Supabase client, so the proxy can use the one it already has. */
export async function recordHit(supabase: SupabaseClient, name: LimitName, scope: string, subject: string): Promise<LimitOutcome> {
  try {
    const { data, error } = await supabase.rpc("rate_limit_hit", {
      p_proof: secret("RATE_LIMIT_KEY", 32),
      p_bucket: bucketFor(scope, subject),
      p_limit: scaled(name),
      p_window_seconds: LIMITS[name].windowSeconds,
    });
    if (error) {
      console.error("rate_limit_unavailable", error.code ?? "unknown", setupHint(error.code));
      return "unavailable";
    }
    return data === true ? "ok" : "limited";
  } catch (e) {
    const reason = e instanceof Error ? e.name : "unknown";
    const missing = e instanceof Error && /is not configured$/.test(e.message) ? "MISSING_SETTING" : undefined;
    console.error("rate_limit_unavailable", missing ?? reason, setupHint(missing));
    return "unavailable";
  }
}

/**
 * Outside production, says in words why the counter could not be checked and what fixes it, so a
 * broken local setup is not mistaken for "too many requests". Codes only; never a value.
 */
function setupHint(code: string | undefined): string {
  if (process.env.NODE_ENV === "production") return "";
  switch (code) {
    case "PT403":
      return "(local setup: the database does not recognise this server's RATE_LIMIT_KEY; run `pnpm local:doctor`)";
    case "PGRST202":
    case "42883":
      return "(local setup: the rate-limit database function is missing or out of date; database changes are pending; run `pnpm local:doctor`)";
    case "MISSING_SETTING":
      return "(local setup: RATE_LIMIT_KEY or RATE_LIMIT_SALT is missing from .env.local; run `node scripts/write-local-env.mjs`)";
    default:
      return "(local setup: the database could not be reached; is the local Supabase stack running? run `pnpm local:doctor`)";
  }
}

/** The outcome for an API request: "ok", "limited" (asked too often) or "unavailable" (could not check). */
export async function checkRateLimit(request: Request, name: LimitName = "catalog", scope: string = name): Promise<LimitOutcome> {
  const supabase = await createSupabaseServerClient();
  return recordHit(supabase, name, scope, clientAddress(request.headers));
}

/** True when the request is within the limit. A counter that cannot be reached counts as "no". */
export async function withinRateLimit(request: Request, name: LimitName = "catalog", scope: string = name): Promise<boolean> {
  return (await checkRateLimit(request, name, scope)) === "ok";
}

/** For pages and server actions, which have headers but no Request object. `subject` defaults to the caller's address. */
export async function checkActionLimit(headers: Headers, name: LimitName, subject?: string): Promise<LimitOutcome> {
  const supabase = await createSupabaseServerClient();
  return recordHit(supabase, name, name, subject ?? clientAddress(headers));
}

export async function withinActionLimit(headers: Headers, name: LimitName, subject?: string): Promise<boolean> {
  return (await checkActionLimit(headers, name, subject)) === "ok";
}

/** Seconds a refused caller is asked to wait: the length of that limit's window. */
export function retryAfterSeconds(name: LimitName): number {
  return LIMITS[name].windowSeconds;
}
