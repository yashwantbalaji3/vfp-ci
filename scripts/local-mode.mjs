// Switches YOUR LOCAL app between demo places and the real Boston directory (R-CAT, docs/50). Local only.
//
//   node scripts/local-mode.mjs status   # says which mode .env.local is in; changes nothing
//   node scripts/local-mode.mjs real     # real places lead Discover; invented places, dishes and reviews are hidden
//   node scripts/local-mode.mjs demo     # back to the demo content exactly as before
//
// It changes two lines of .env.local (ALLOW_DEMO_CONTENT and REAL_DISCOVERY) and nothing else: no database row,
// listing, batch, switch or lock. Before the first change it keeps a copy of .env.local as .env.local.before-real-mode.
// Restart `pnpm dev` (or rebuild for `pnpm start`) after switching. Real places stay private to the founder:
// public activation is a separate owner decision and is not touched here.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The mode a .env.local text is in: "real", "demo" or "mixed" (anything else). */
export function modeOf(text) {
  const get = (k) => text.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim();
  const demo = get("ALLOW_DEMO_CONTENT");
  const real = get("REAL_DISCOVERY");
  if (demo === "false" && real === "true") return "real";
  if (demo === "true" && (real === undefined || real === "false")) return "demo";
  return "mixed";
}

/** The .env.local text switched to a mode. Only the two setting lines change; every other line is kept as it is. */
export function withMode(text, mode) {
  if (mode !== "real" && mode !== "demo") throw new Error("Mode must be real or demo.");
  const want = mode === "real" ? { ALLOW_DEMO_CONTENT: "false", REAL_DISCOVERY: "true" } : { ALLOW_DEMO_CONTENT: "true", REAL_DISCOVERY: "false" };
  let out = text.endsWith("\n") || text === "" ? text : `${text}\n`;
  for (const [k, v] of Object.entries(want)) {
    const re = new RegExp(`^${k}=.*$`, "m");
    out = re.test(out) ? out.replace(re, `${k}=${v}`) : `${out}${k}=${v}\n`;
  }
  return out;
}

const WORDS = {
  real: "Real mode: Discover leads with real Boston places (private to the founder); demo places, dishes and reviews are hidden, not deleted.",
  demo: "Demo mode: the invented example places and dishes are shown, as before.",
  mixed: "Mixed settings: run `node scripts/local-mode.mjs demo` or `... real` to pick one.",
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  if (!existsSync(".env.local")) {
    console.error("No .env.local here. Run this from the project folder after `node scripts/write-local-env.mjs`.");
    process.exit(1);
  }
  const text = readFileSync(".env.local", "utf8");
  if (!/^NEXT_PUBLIC_SUPABASE_URL=http:\/\/(127\.0\.0\.1|localhost):/m.test(text)) {
    console.error("This .env.local does not point at a local database. Nothing changed.");
    process.exit(1);
  }
  if (cmd === "status" || cmd === undefined) {
    console.log(WORDS[modeOf(text)]);
  } else if (cmd === "real" || cmd === "demo") {
    if (!existsSync(".env.local.before-real-mode")) copyFileSync(".env.local", ".env.local.before-real-mode");
    writeFileSync(".env.local", withMode(text, cmd));
    console.log(`${WORDS[cmd]}\nRestart the app (stop \`pnpm dev\` with Ctrl+C and start it again) to see the change.`);
  } else {
    console.error("Use: node scripts/local-mode.mjs status|real|demo");
    process.exit(1);
  }
}
