// Which database a data script may write to (owner direction 25 Nov 2026 21:53 UTC: hosted menu import in isolated
// test environments first; any real transfer only with the owner's explicit approval).
//
// A script runs against a database on this computer, as before. It runs against a hosted Supabase database only
// when ALL of these hold:
//   1. the command is one the script lists as safe for a hosted database (loading and linking, never publishing,
//      never a founder decision, never a switch);
//   2. VFP_HOSTED_REF names the project, a 20-character Supabase project id; and
//   3. the database address belongs to exactly that project: db.<ref>.supabase.co, or a Supabase pooler address
//      whose user is postgres.<ref>.
// Anything else is refused before a connection is opened. The address and its password are never printed.

const LOCAL = /@(127\.0\.0\.1|localhost):/;
const REF = /^[a-z0-9]{20}$/;

/** "local", "hosted" (with the ref), or a refusal reason. Pure, so it is unit-tested. */
export function classifyTarget(url, env = process.env) {
  if (LOCAL.test(url)) return { kind: "local" };
  const ref = env.VFP_HOSTED_REF ?? "";
  if (!ref) return { kind: "refused", reason: "not a local database, and VFP_HOSTED_REF does not name a hosted project" };
  if (!REF.test(ref)) return { kind: "refused", reason: "VFP_HOSTED_REF is not a Supabase project id (20 lowercase letters or digits)" };
  let u;
  try {
    u = new URL(url);
  } catch {
    return { kind: "refused", reason: "the database address could not be read" };
  }
  const host = u.hostname.toLowerCase();
  const user = decodeURIComponent(u.username);
  const direct = host === `db.${ref}.supabase.co`;
  const pooled = /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(host) && user === `postgres.${ref}`;
  if (!direct && !pooled) return { kind: "refused", reason: `the database address does not belong to project ${ref}` };
  return { kind: "hosted", ref };
}

/**
 * Throws unless this command may run against this database. `hostedCommands` lists the commands that are safe on
 * a hosted database (pass [] or omit for a local-only script). Returns the classification.
 */
export function assertTarget(url, command, hostedCommands = []) {
  const t = classifyTarget(url);
  if (t.kind === "local") return t;
  if (t.kind === "refused") throw new Error(`Runs only against a local database (${t.reason}).`);
  if (!hostedCommands.includes(command ?? ""))
    throw new Error(`"${command ?? ""}" runs only against a local database. On hosted project ${t.ref} only these may run: ${hostedCommands.join(", ") || "none"}.`);
  return t;
}
