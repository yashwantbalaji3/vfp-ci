import { connection } from "next/server";

/** Operational status only: never credentials, configuration or user data. */
export async function GET() {
  await connection(); // evaluated per request, not prerendered
  return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}
