import "server-only";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import { FLAGS } from "@/config/flags";

/**
 * The street-map file (MAP-1.1, docs/21). One `.pmtiles` file of OpenStreetMap data, kept on this
 * computer and served by this app only: no map company, no key, no request to anyone else.
 *
 * Which file is set by the server-only setting MAP_STREET_FILE (a path relative to the project, or
 * absolute). It is never taken from a request, so a visitor cannot make the app read another file.
 * With no setting, or no file there, the map keeps its plain background (the tested fallback).
 */
export type StreetFile = { file: string; size: number; etag: string; modified: Date };

export async function streetFile(): Promise<StreetFile | null> {
  if (!FLAGS.mapEnabled) return null;
  const setting = process.env.MAP_STREET_FILE;
  if (!setting || !setting.endsWith(".pmtiles")) return null;
  // The path comes only from the server's own setting, never from a request.
  const file = path.resolve(/*turbopackIgnore: true*/ process.cwd(), setting);
  try {
    const s = await stat(file);
    if (!s.isFile() || s.size < 127) return null;
    return { file, size: s.size, etag: `"${s.size.toString(16)}-${Math.floor(s.mtimeMs).toString(16)}"`, modified: s.mtime };
  } catch {
    return null;
  }
}

/** Largest piece served in one answer; the map reader asks for pieces far smaller than this. */
export const MAX_RANGE = 8 * 1024 * 1024;

/** Parses one "bytes=a-b" range (the only form the map reader sends). Null means "not satisfiable". */
export function parseRange(header: string, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number;
  let end: number;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return null;
  if (end - start + 1 > MAX_RANGE) end = start + MAX_RANGE - 1;
  return { start, end };
}

export async function readPiece(file: string, start: number, end: number): Promise<Uint8Array> {
  const handle = await open(file, "r");
  try {
    const buf = new Uint8Array(end - start + 1);
    let done = 0;
    while (done < buf.length) {
      const { bytesRead } = await handle.read(buf, done, buf.length - done, start + done);
      if (bytesRead === 0) break;
      done += bytesRead;
    }
    return done === buf.length ? buf : buf.subarray(0, done);
  } finally {
    await handle.close();
  }
}
