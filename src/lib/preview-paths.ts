/**
 * Pages a real-meal action or a meal page's back link may return to (docs/60). Anything else falls back to
 * the meal list, so a crafted link can never send the founder somewhere unexpected.
 */
export const PREVIEW_RETURN =
  /^\/(protein\/meals|places\/[a-z0-9-]+|places\/menus|meals\/[0-9a-f-]{36}|saved|search|discover|lists\/[0-9a-f-]{36}|friends\/lists\/[0-9a-f-]{36}|friends\/reviews|cook\/plan)(\?[^#\s]*)?(#[a-z0-9-]+)?$/;
export const safeReturn = (v: unknown, fallback = "/protein/meals") => (typeof v === "string" && v.length <= 400 && PREVIEW_RETURN.test(v) ? v : fallback);
