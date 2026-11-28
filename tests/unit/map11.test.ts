import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { headerFits, plainStyle, streetStyle, PLAIN_CREDIT, STREET_CREDIT } from "@/lib/street-style";

// MAP-1.1 logic that runs without a browser: the street-map file route, the style and the colours.

describe("street style (MAP-1.1)", () => {
  it("reads tiles, fonts and icons only from this site and credits OpenStreetMap and Protomaps", () => {
    const style = streetStyle("http://localhost:3000/map-data/streets", "http://localhost:3000");
    const urls = [style.glyphs, style.sprite, (style.sources.protomaps as { url: string }).url].map(String);
    expect(urls).toEqual([
      "http://localhost:3000/maps/assets/fonts/{fontstack}/{range}.pbf",
      "http://localhost:3000/maps/assets/sprites/v4/light",
      "pmtiles://http://localhost:3000/map-data/streets",
    ]);
    expect(JSON.stringify(style)).not.toMatch(/protomaps\.github\.io|build\.protomaps\.com|tile\.openstreetmap|api\.|key=/);
    expect(STREET_CREDIT).toContain('href="https://www.openstreetmap.org/copyright"');
    expect(STREET_CREDIT).toContain("Protomaps");
    expect((style.sources.protomaps as { attribution: string }).attribution).toBe(STREET_CREDIT);
  });
  it("leaves out OpenStreetMap shops and restaurants so they are never mistaken for checked places", () => {
    const ids = streetStyle("http://x/map-data/streets", "http://x").layers.map((l) => l.id);
    expect(ids).not.toContain("pois");
    expect(ids).toContain("roads_labels_major");
    expect(ids).toContain("places_subplace");
    // Only the bundled fonts are ever asked for (Devanagari is used only for names written in that script).
    const fonts = new Set(JSON.stringify(streetStyle("http://x/a", "http://x").layers).match(/Noto Sans [A-Za-z]+/g));
    expect([...fonts].sort()).toEqual(["Noto Sans Devanagari", "Noto Sans Italic", "Noto Sans Medium", "Noto Sans Regular"]);
  });
  it("the plain fallback fetches nothing and keeps its honest credit", () => {
    const style = plainStyle();
    expect(style.glyphs).toBeUndefined();
    expect(style.sprite).toBeUndefined();
    expect(style.sources).toEqual({});
    expect(PLAIN_CREDIT).toMatch(/^Demo map: plain background, no street map\./);
  });
  it("uses a street-map file only if it is vector tiles that overlap the market", () => {
    const boston = { tileType: 1, minLon: -71.3, minLat: 42.2, maxLon: -70.9, maxLat: 42.45, maxZoom: 15 };
    const market: [number, number, number, number] = [-71.6, 42.0, -70.6, 42.7];
    expect(headerFits(boston, market)).toBe(true);
    expect(headerFits({ ...boston, tileType: 2 }, market)).toBe(false); // raster images
    expect(headerFits({ ...boston, maxZoom: 10 }, market)).toBe(false); // too little detail
    expect(headerFits({ ...boston, minLon: -74.1, maxLon: -73.7, minLat: 40.6, maxLat: 40.9 }, market)).toBe(false); // another city
  });
});

describe("pin contrast on the map backgrounds (docs/19)", () => {
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a: string, b: string) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  it("pins and their numbers stand out against every street-map fill they can sit on", () => {
    const style = streetStyle("http://x/a", "http://x");
    const fills = new Set<string>(["#eef0e8"]);
    for (const l of style.layers) {
      const c = (l.paint as Record<string, unknown> | undefined)?.[l.type === "background" ? "background-color" : "fill-color"];
      if (typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) && (l.type === "fill" || l.type === "background")) fills.add(c.toLowerCase());
    }
    expect(fills.size).toBeGreaterThan(3);
    for (const bg of fills) {
      // The "fits" pin (--action) and the dashed "needs confirmation" outline (--warning-ink): 3:1 for shapes (WCAG 1.4.11).
      expect(ratio("#254d38", bg), `fits pin on ${bg}`).toBeGreaterThanOrEqual(3);
      expect(ratio("#5a3b12", bg), `needs-confirmation pin on ${bg}`).toBeGreaterThanOrEqual(3);
    }
    // Numbers inside pins: 4.5:1 (WCAG 1.4.3).
    expect(ratio("#ffffff", "#254d38")).toBeGreaterThanOrEqual(4.5);
    expect(ratio("#5a3b12", "#fbefd2")).toBeGreaterThanOrEqual(4.5);
  });
});

describe("street-map file route /map-data/streets (MAP-1.1)", () => {
  let dir: string;
  let file: string;
  const bytes = Uint8Array.from({ length: 4000 }, (_, i) => i % 251);
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "streets-"));
    file = path.join(dir, "test.pmtiles");
    writeFileSync(file, bytes);
    vi.resetModules();
    vi.doMock("server-only", () => ({}));
    vi.doMock("next/server", () => ({ connection: async () => undefined }));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.doUnmock("server-only");
    vi.doUnmock("next/server");
  });
  async function route(env: Record<string, string>) {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    return import("@/app/map-data/streets/route");
  }

  it("answers byte ranges with 206, the exact bytes and the total size", async () => {
    const { GET } = await route({ MAP_ENABLED: "true", MAP_STREET_FILE: file });
    const res = await GET(new Request("http://localhost/map-data/streets", { headers: { Range: "bytes=10-19" } }));
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 10-19/4000");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...bytes.slice(10, 20)]);
    const tail = await GET(new Request("http://localhost/map-data/streets", { headers: { Range: "bytes=-5" } }));
    expect(tail.headers.get("content-range")).toBe("bytes 3995-3999/4000");
  });
  it("refuses impossible ranges with 416", async () => {
    const { GET } = await route({ MAP_ENABLED: "true", MAP_STREET_FILE: file });
    for (const r of ["bytes=5000-6000", "bytes=20-10", "items=0-10", "bytes=0-1,5-9"]) {
      const res = await GET(new Request("http://localhost/map-data/streets", { headers: { Range: r } }));
      expect(res.status, r).toBe(416);
    }
  });
  it("is not found when the map is off, no file is set, the setting is not a .pmtiles file, or the file is missing", async () => {
    for (const env of [
      { MAP_ENABLED: "false", MAP_STREET_FILE: file },
      { MAP_ENABLED: "true", MAP_STREET_FILE: "" },
      { MAP_ENABLED: "true", MAP_STREET_FILE: path.join(dir, "secret.txt") },
      { MAP_ENABLED: "true", MAP_STREET_FILE: path.join(dir, "missing.pmtiles") },
    ]) {
      vi.resetModules();
      const { GET, HEAD } = await route(env);
      expect((await GET(new Request("http://localhost/map-data/streets", { headers: { Range: "bytes=0-9" } }))).status, JSON.stringify(env)).toBe(404);
      expect((await HEAD()).status).toBe(404);
    }
  });
  it("never reads a path from the request", async () => {
    const { GET } = await route({ MAP_ENABLED: "true", MAP_STREET_FILE: file });
    const res = await GET(new Request("http://localhost/map-data/streets?file=/etc/passwd", { headers: { Range: "bytes=0-9" } }));
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...bytes.slice(0, 10)]);
  });
});
