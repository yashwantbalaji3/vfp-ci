import { privateJson } from "@/server/http";
import { getDesk, getStaffAlerts } from "@/server/editor";
import { socialRoute } from "@/server/social/api";

/** Catalog editors only (the database checks the role): what is waiting, and the staff counts. */
export async function GET(request: Request) {
  return socialRoute(request, async () => {
    const desk = await getDesk();
    return privateJson({ desk, alerts: await getStaffAlerts() });
  });
}
