// NIE V1 slice N-1: writes normalized USDA foods into the local reference tables (docs/24 3.2).
// Used by scripts/usda-import.mjs and by tests/db/nie-usda.test.ts, so both run the same code.
import { IMPORTER_VERSION, normalizeFood, recordHash, releaseHash } from "./usda-normalize.mjs";

/** Normalizes raw foods and builds the release summary. Throws on a duplicate FDC ID. */
export function prepareRelease(meta, raws) {
  const seen = new Set();
  const records = [];
  const refused = [];
  for (const raw of raws) {
    const { record, refused: r } = normalizeFood(raw);
    if (seen.has(record.fdcId)) throw new Error(`Duplicate FDC ID ${record.fdcId}`);
    seen.add(record.fdcId);
    records.push(record);
    for (const x of r) refused.push({ fdcId: record.fdcId, ...x });
  }
  records.sort((a, b) => a.fdcId - b.fdcId);
  const coverage = {};
  for (const rec of records) for (const k of Object.keys(rec.nutrients)) coverage[k] = (coverage[k] ?? 0) + 1;
  const energyFrom = {};
  for (const rec of records) {
    const e = rec.nutrients.energy_kcal;
    if (e) energyFrom[e.usdaNutrientId] = (energyFrom[e.usdaNutrientId] ?? 0) + 1;
  }
  const report = {
    foods: records.length,
    nutrientCoverage: coverage,
    energyFromUsdaNutrient: energyFrom,
    portions: records.reduce((n, r) => n + r.portions.length, 0),
    refusedCount: refused.length,
    refused: refused.slice(0, 200),
  };
  return {
    release: {
      dataset: meta.dataset,
      releaseLabel: meta.releaseLabel,
      fileName: meta.fileName,
      fileSha256: meta.sha256,
      sourceUrl: meta.sourceUrl,
      importerVersion: meta.importerVersion ?? IMPORTER_VERSION,
      foodCount: records.length,
      contentSha256: releaseHash(records),
      report,
    },
    records,
  };
}

/**
 * Writes one prepared release with `client` (a pg client, inside the caller's transaction).
 * Returns {status: "new" | "unchanged", releaseId, foods}.
 */
export async function writeRelease(client, prepared, batchSize = 500) {
  const begin = (await client.query("select app.usda_begin_release($1::jsonb) as r", [JSON.stringify(prepared.release)])).rows[0].r;
  if (begin.status === "unchanged") return { status: "unchanged", releaseId: begin.releaseId, foods: prepared.release.foodCount };
  for (let i = 0; i < prepared.records.length; i += batchSize) {
    const batch = prepared.records.slice(i, i + batchSize).map((r) => ({ ...r, recordSha256: recordHash(r) }));
    await client.query("select app.usda_add_foods($1::uuid, $2::jsonb)", [begin.releaseId, JSON.stringify(batch)]);
  }
  const sealed = (await client.query("select app.usda_seal_release($1::uuid) as r", [begin.releaseId])).rows[0].r;
  return { status: "new", releaseId: begin.releaseId, foods: sealed.foods };
}
