// MAP-1 privacy check (docs/14 T-MAP 10). LOCAL ONLY.
//   node scripts/check-location-logs.mjs <log file>...
// Looks for the test positions used by the browser and database tests in the app server's log
// and in the local Supabase containers' logs (database, Data API, gateway, auth). Any hit fails.
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

// Precise and rounded forms of every position the MAP-1 tests send.
const NEEDLES = ["42.365519", "71.104031", "42.3655", "42.366", "71.104", "42.36791", "71.10937", "42.35217", "71.06483", "34.05", "118.24"];
const sources = [];
for (const file of process.argv.slice(2)) {
  if (!existsSync(file)) throw new Error(`No such log: ${file}`);
  sources.push([file, readFileSync(file, "utf8")]);
}
const containers = execFileSync("docker", ["ps", "--format", "{{.Names}}"]).toString().split("\n").filter((n) => /^supabase_.*vegetarian-food-platform$/.test(n));
for (const name of containers) {
  const out = execFileSync("docker", ["logs", name], { maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  sources.push([`docker:${name}`, out.toString()]);
}
let hits = 0;
for (const [where, text] of sources) {
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    // Seeded place positions (e.g. "-71.1040, 42.3655" in seed.sql) never appear in logs either; any match is reported.
    if (NEEDLES.some((n) => line.includes(n))) {
      hits++;
      if (hits <= 20) console.log(`${where}:${i + 1}: ${line.slice(0, 300)}`);
    }
  });
}
console.log(JSON.stringify({ checked: sources.map(([w, t]) => ({ source: w, lines: t.split("\n").length })), needles: NEEDLES.length, hits }));
if (hits > 0) process.exit(1);
