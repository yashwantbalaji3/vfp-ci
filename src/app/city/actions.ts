"use server";
import { redirect } from "next/navigation";
import { safeReturnPath } from "@/lib/format";
import { writeMarket } from "@/server/market";

export async function chooseCity(formData: FormData) {
  const slug = formData.get("market");
  await writeMarket(typeof slug === "string" ? slug : "");
  redirect(safeReturnPath(formData.get("return") as string | null));
}
