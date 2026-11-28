// Writes tests/fixtures/maps/central-square.pmtiles: a tiny street map made ENTIRELY of invented
// shapes (MAP-1.1, decision M11-3). It contains no OpenStreetMap or other third-party data, so it
// carries no licence obligation; it exists so automated checks always exercise the real street-map
// path (file route, byte ranges, the pmtiles reader, the Protomaps style) without the large Boston
// file. Run: node scripts/make-test-map.mjs   (deterministic: the same bytes every time)
import { gzipSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { zxyToTileId } from "pmtiles";

const OUT = "tests/fixtures/maps/central-square.pmtiles";
const BOX = { west: -71.12, south: 42.355, east: -71.09, north: 42.375 }; // around the demo Central Square places
const ZOOMS = [12, 13, 14, 15];
const EXTENT = 4096;
const BUFFER = 64;

// ---- invented geography (not real streets; names say so) ----
const L = (lon, lat) => [lon, lat];
const features = {
  earth: [{ type: 3, props: { kind: "earth" }, rings: [[L(-71.2, 42.3), L(-71.0, 42.3), L(-71.0, 42.45), L(-71.2, 42.45), L(-71.2, 42.3)]] }],
  water: [{ type: 3, props: { kind: "water", name: "Test Pond (invented)" }, rings: [[L(-71.112, 42.357), L(-71.104, 42.357), L(-71.104, 42.361), L(-71.112, 42.361), L(-71.112, 42.357)]] }],
  landuse: [{ type: 3, props: { kind: "park", name: "Test Park (invented)" }, rings: [[L(-71.099, 42.366), L(-71.094, 42.366), L(-71.094, 42.37), L(-71.099, 42.37), L(-71.099, 42.366)]] }],
  roads: [
    { type: 2, props: { kind: "major_road", kind_detail: "primary", name: "Test Avenue (invented)", min_zoom: 7 }, lines: [[L(-71.12, 42.365), L(-71.103, 42.3655), L(-71.09, 42.366)]] },
    { type: 2, props: { kind: "minor_road", kind_detail: "residential", name: "Test Street (invented)", min_zoom: 12 }, lines: [[L(-71.105, 42.355), L(-71.104, 42.375)]] },
    { type: 2, props: { kind: "minor_road", kind_detail: "residential", name: "Sample Lane (invented)", min_zoom: 12 }, lines: [[L(-71.115, 42.371), L(-71.095, 42.359)]] },
  ],
  places: [{ type: 1, props: { kind: "neighbourhood", name: "Test Square (invented)", min_zoom: 11 }, points: [L(-71.1035, 42.3653)] }],
};

// ---- projection ----
const tileXY = (lon, lat, z) => {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const r = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  return [x, y];
};

// ---- protobuf helpers ----
const varint = (n, out) => {
  n = Math.floor(n);
  while (n > 127) {
    out.push((n & 127) | 128);
    n = Math.floor(n / 128);
  }
  out.push(n);
};
const zz = (n) => (n << 1) ^ (n >> 31);
const key = (field, wire, out) => varint((field << 3) | wire, out);
const bytesField = (field, bytes, out) => {
  key(field, 2, out);
  varint(bytes.length, out);
  for (const b of bytes) out.push(b);
};
const str = (s) => [...Buffer.from(s, "utf8")];

function geometry(f, z, tx, ty) {
  const cmds = [];
  let cx = 0;
  let cy = 0;
  // Points are kept within a small margin outside the tile (BUFFER), as map tiles are expected to be;
  // the clamped parts lie outside the drawn area, so the visible shapes do not change.
  const clamp = (v) => Math.max(-BUFFER, Math.min(EXTENT + BUFFER, v));
  const pt = ([lon, lat]) => {
    const [x, y] = tileXY(lon, lat, z);
    return [clamp(Math.round((x - tx) * EXTENT)), clamp(Math.round((y - ty) * EXTENT))];
  };
  const move = (p, count, cmd) => {
    cmds.push((cmd & 7) | (count << 3));
  };
  const delta = ([x, y]) => {
    cmds.push(zz(x - cx), zz(y - cy));
    cx = x;
    cy = y;
  };
  if (f.type === 1) {
    move(null, f.points.length, 1);
    f.points.map(pt).forEach(delta);
  } else if (f.type === 2) {
    for (const line of f.lines) {
      const p = line.map(pt);
      move(null, 1, 1);
      delta(p[0]);
      move(null, p.length - 1, 2);
      p.slice(1).forEach(delta);
    }
  } else {
    for (const ring of f.rings) {
      const p = ring.slice(0, -1).map(pt);
      move(null, 1, 1);
      delta(p[0]);
      move(null, p.length - 1, 2);
      p.slice(1).forEach(delta);
      cmds.push(7 | (1 << 3));
    }
  }
  return cmds;
}

function layerBytes(name, list, z, tx, ty) {
  const keys = [];
  const values = [];
  const out = [];
  key(15, 0, out);
  varint(2, out); // version
  bytesField(1, str(name), out);
  list.forEach((f, i) => {
    const tags = [];
    for (const [k, v] of Object.entries(f.props)) {
      let ki = keys.indexOf(k);
      if (ki < 0) ki = keys.push(k) - 1;
      const vk = `${typeof v}:${v}`;
      let vi = values.findIndex((x) => x.k === vk);
      if (vi < 0) vi = values.push({ k: vk, v }) - 1;
      tags.push(ki, vi);
    }
    const feat = [];
    key(1, 0, feat);
    varint(i + 1, feat);
    const packedTags = [];
    tags.forEach((t) => varint(t, packedTags));
    bytesField(2, packedTags, feat);
    key(3, 0, feat);
    varint(f.type, feat);
    const packedGeom = [];
    geometry(f, z, tx, ty).forEach((c) => varint(c, packedGeom));
    bytesField(4, packedGeom, feat);
    bytesField(2, feat, out);
  });
  keys.forEach((k) => bytesField(3, str(k), out));
  values.forEach(({ v }) => {
    const val = [];
    if (typeof v === "number") {
      key(4, 0, val); // int_value
      varint(v, val);
    } else {
      bytesField(1, str(String(v)), val);
    }
    bytesField(4, val, out);
  });
  key(5, 0, out);
  varint(EXTENT, out);
  return out;
}

// ---- tiles ----
const tiles = [];
for (const z of ZOOMS) {
  const [x0, y0] = tileXY(BOX.west, BOX.north, z).map(Math.floor);
  const [x1, y1] = tileXY(BOX.east, BOX.south, z).map(Math.floor);
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      const tile = [];
      for (const [name, list] of Object.entries(features)) bytesField(3, layerBytes(name, list, z, x, y), tile);
      tiles.push({ id: zxyToTileId(z, x, y), data: gzipSync(Buffer.from(tile), { level: 9, mtime: 0 }) });
    }
  }
}
tiles.sort((a, b) => a.id - b.id);

// ---- PMTiles v3 ----
let offset = 0;
const entries = tiles.map((t) => {
  const e = { id: t.id, offset, length: t.data.length };
  offset += t.data.length;
  return e;
});
const dir = [];
varint(entries.length, dir);
let last = 0;
for (const e of entries) {
  varint(e.id - last, dir);
  last = e.id;
}
for (let i = 0; i < entries.length; i++) varint(1, dir); // run lengths
for (const e of entries) varint(e.length, dir);
for (let i = 0; i < entries.length; i++) varint(i === 0 ? e0(entries) : 0, dir); // 0 = follows the previous tile
function e0(list) {
  return list[0].offset + 1;
}
const root = gzipSync(Buffer.from(dir), { mtime: 0 });
const meta = gzipSync(
  Buffer.from(
    JSON.stringify({
      name: "Invented test map (not real geography)",
      description: "Synthetic shapes for automated tests of the Vegetarian Food Platform map. No third-party data.",
      vector_layers: Object.keys(features).map((id) => ({ id, fields: {} })),
    }),
  ),
  { mtime: 0 },
);
const tileData = Buffer.concat(tiles.map((t) => t.data));

const header = Buffer.alloc(127);
const u64 = (pos, v) => header.writeBigUInt64LE(BigInt(v), pos);
header.write("PMTiles", 0, "ascii");
header.writeUInt8(3, 7);
const rootOff = 127;
const metaOff = rootOff + root.length;
const dataOff = metaOff + meta.length;
u64(8, rootOff);
u64(16, root.length);
u64(24, metaOff);
u64(32, meta.length);
u64(40, dataOff); // no leaf directories
u64(48, 0);
u64(56, dataOff);
u64(64, tileData.length);
u64(72, tiles.length);
u64(80, tiles.length);
u64(88, tiles.length);
header.writeUInt8(1, 96); // clustered
header.writeUInt8(2, 97); // internal compression gzip
header.writeUInt8(2, 98); // tile compression gzip
header.writeUInt8(1, 99); // vector tiles (MVT)
header.writeUInt8(ZOOMS[0], 100);
header.writeUInt8(ZOOMS.at(-1), 101);
const e7 = (v) => Math.round(v * 1e7);
header.writeInt32LE(e7(BOX.west), 102);
header.writeInt32LE(e7(BOX.south), 106);
header.writeInt32LE(e7(BOX.east), 110);
header.writeInt32LE(e7(BOX.north), 114);
header.writeUInt8(14, 118);
header.writeInt32LE(e7(-71.1035), 119);
header.writeInt32LE(e7(42.3653), 123);

mkdirSync("tests/fixtures/maps", { recursive: true });
const file = Buffer.concat([header, root, meta, tileData]);
writeFileSync(OUT, file);
console.log(`Wrote ${OUT}: ${file.length} bytes, ${tiles.length} tiles, zoom ${ZOOMS[0]}-${ZOOMS.at(-1)}.`);
