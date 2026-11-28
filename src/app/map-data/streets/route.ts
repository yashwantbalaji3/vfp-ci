import { connection } from "next/server";
import { MAX_RANGE, parseRange, readPiece, streetFile } from "@/server/map-tiles";

/**
 * GET /map-data/streets: the street-map file, in the pieces ("byte ranges") the map reader asks
 * for (MAP-1.1). Served from this app only, so the browser never contacts another site.
 * Not found unless Map Discovery is on and a street-map file is configured on the server.
 * The file holds only OpenStreetMap streets, water, parks and names (ODbL, credited on the map).
 */
const COMMON = {
  "Accept-Ranges": "bytes",
  "Content-Type": "application/octet-stream",
  // Public street data, the same for everyone; revalidated by its fingerprint.
  "Cache-Control": "public, max-age=3600, must-revalidate",
  "X-Content-Type-Options": "nosniff",
};

function notFound() {
  return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
}

export async function HEAD() {
  // Answered per request: the file can be added or replaced while the app runs.
  await connection();
  const f = await streetFile();
  if (!f) return notFound();
  return new Response(null, { status: 200, headers: { ...COMMON, ETag: f.etag, "Content-Length": String(f.size) } });
}

export async function GET(request: Request) {
  await connection();
  const f = await streetFile();
  if (!f) return notFound();
  const headers = { ...COMMON, ETag: f.etag, "Last-Modified": f.modified.toUTCString() };
  const ifRange = request.headers.get("if-range");
  const rangeHeader = request.headers.get("range");
  if (!rangeHeader || (ifRange && ifRange !== f.etag)) {
    // A whole-file request is refused when the file is larger than one piece: the map never needs it.
    if (f.size > MAX_RANGE) {
      return new Response("Ask for a byte range", { status: 416, headers: { ...headers, "Content-Range": `bytes */${f.size}` } });
    }
    const body = await readPiece(f.file, 0, f.size - 1);
    return new Response(body as BodyInit, { status: 200, headers: { ...headers, "Content-Length": String(body.length) } });
  }
  const range = parseRange(rangeHeader, f.size);
  if (!range) return new Response("Range not satisfiable", { status: 416, headers: { ...headers, "Content-Range": `bytes */${f.size}` } });
  const body = await readPiece(f.file, range.start, range.end);
  return new Response(body as BodyInit, {
    status: 206,
    headers: { ...headers, "Content-Range": `bytes ${range.start}-${range.start + body.length - 1}/${f.size}`, "Content-Length": String(body.length) },
  });
}
