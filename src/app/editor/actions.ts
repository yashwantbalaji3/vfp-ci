"use server";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { idSchema } from "@/contracts/catalog";
import { FAMILIES, NUTRIENTS, SOURCE_TYPES, type Change } from "@/contracts/editor";
import { handleSchema } from "@/contracts/social";
import { safeReturnPath } from "@/lib/format";
import { getCurrentMember } from "@/server/auth/session";
import * as editor from "@/server/editor";
import { withinActionLimit } from "@/server/rate-limit";
import { SocialError } from "@/server/social";
import { hoursFromForm } from "@/components/editor/hours-fields";

/**
 * Editor and moderator form posts (R2). Each action checks the session, applies
 * the per-member press limit, and calls one database function that checks the
 * role again. Nothing here publishes: only the second person's approval does.
 */
type Outcome = string | { to: string; code: string };
const text = (fd: FormData, name: string) => {
  const v = fd.get(name);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
};
const num = (fd: FormData, name: string) => {
  const v = text(fd, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new SocialError(422, "INVALID_PATCH");
  return n;
};
function withCode(path: string, key: "m" | "e", code: string): string {
  const [base, query = ""] = path.split("?");
  const params = new URLSearchParams(query);
  params.delete("m");
  params.delete("e");
  params.set(key, code);
  return `${base}?${params.toString()}`;
}
async function act(formData: FormData, fallback: string, fn: () => Promise<Outcome>): Promise<never> {
  const returnTo = safeReturnPath(formData.get("return") as string | null, fallback);
  const member = await getCurrentMember();
  if (!member) redirect(`/login?next=${encodeURIComponent(returnTo)}`);
  if (!(await withinActionLimit(await headers(), "memberAction", member.id))) redirect("/slow-down");
  let outcome: Outcome;
  try {
    outcome = await fn();
  } catch (e) {
    if (e instanceof SocialError) redirect(withCode(returnTo, "e", e.code));
    throw e;
  }
  redirect(typeof outcome === "string" ? withCode(returnTo, "m", outcome) : withCode(outcome.to, "m", outcome.code));
}
const invalid = (): never => {
  throw new SocialError(422, "INVALID_REQUEST");
};
const changePath = (id: unknown) => `/editor/changes/${String(id)}`;

export async function startChangeAction(formData: FormData) {
  await act(formData, "/editor", async () => {
    const correction = idSchema.safeParse(formData.get("correctionId"));
    const food = idSchema.safeParse(formData.get("foodItemId"));
    const venue = idSchema.safeParse(formData.get("venueId"));
    if (food.success) {
      const r = await editor.startChange(food.data, correction.success ? correction.data : undefined);
      return { to: changePath(r.changeId), code: "change_started" };
    }
    if (venue.success || formData.get("newVenue") === "1") {
      const r = await editor.startVenueChange(venue.success ? venue.data : undefined, correction.success ? correction.data : undefined);
      return { to: changePath(r.changeId), code: "change_started" };
    }
    return invalid();
  });
}

export async function newFoodAction(formData: FormData) {
  await act(formData, "/editor/new", async () => {
    const kind = formData.get("kind") === "recipe" ? "recipe" : "dish";
    const venue = idSchema.safeParse(formData.get("venueId"));
    const name = text(formData, "name");
    if (!name) throw new SocialError(422, "NAME_REQUIRED");
    const r = await editor.newFood({ kind, name, venueId: venue.success ? venue.data : undefined, description: text(formData, "description"), menuSection: text(formData, "menuSection") });
    return { to: changePath(r.changeId), code: "change_started" };
  });
}

/** Builds a patch holding only what the form changed, compared with the draft as it is now. */
function patchFrom(formData: FormData, change: Change): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const summary = text(formData, "summary");
  if ((summary ?? null) !== change.summary) patch.summary = summary ?? "";

  const publisher = text(formData, "sourcePublisher");
  const observedOn = text(formData, "sourceObservedOn");
  const sourceSummary = text(formData, "sourceSummary");
  if (publisher || observedOn || sourceSummary) {
    const sourceType = SOURCE_TYPES.find((s) => s === formData.get("sourceType")) ?? "operator_statement";
    patch.source = { publisher: publisher ?? "", sourceType, url: text(formData, "sourceUrl") ?? null, observedOn: observedOn ?? null, summary: sourceSummary ?? "" };
  }

  if (change.kind === "venue") {
    patch.venue = {
      name: text(formData, "name") ?? "",
      neighborhood: text(formData, "neighborhood") ?? null,
      street: text(formData, "street") ?? null,
      locality: text(formData, "locality") ?? null,
      region: text(formData, "region") ?? null,
      postalCode: text(formData, "postalCode") ?? null,
      venueType: text(formData, "venueType") ?? "restaurant",
      status: text(formData, "status") ?? "published",
      lat: num(formData, "lat") ?? null,
      lon: num(formData, "lon") ?? null,
      hours: text(formData, "hours") ?? null,
      statusNote: text(formData, "statusNote") ?? null,
    };
    return patch;
  }

  const draft = change.draft;
  if (!draft) return patch;
  const name = text(formData, "name");
  if (name !== draft.name) patch.name = name ?? "";
  const description = text(formData, "description") ?? null;
  if (description !== (draft.description ?? null)) patch.description = description;

  const dietary: Record<string, unknown>[] = [];
  for (const diet of ["vegan", "vegetarian"]) {
    const outcome = text(formData, `diet_${diet}`);
    const mods = text(formData, `dietmod_${diet}`) ?? null;
    const now = draft.dietary.find((d) => d.diet === diet);
    if (!outcome || outcome === "keep") continue;
    if (outcome === "remove") {
      if (now) dietary.push({ diet, remove: true });
    } else if (!now || now.outcome !== outcome || (now.modifications ?? null) !== mods || now.conflictState === "disputed" || formData.get(`dietrestate_${diet}`) === "on") {
      dietary.push({ diet, outcome, evidenceTier: outcome === "unknown" ? "unknown" : "documented", modifications: mods });
    }
  }
  if (dietary.length) patch.dietary = dietary;

  const families: Record<string, unknown>[] = [];
  for (const family of FAMILIES) {
    const presence = text(formData, `fam_${family}`);
    const detail = text(formData, `famdetail_${family}`) ?? null;
    const now = draft.families.find((f) => f.family === family);
    if (!presence || presence === "keep") continue;
    if (!now || now.presence !== presence || (now.detail ?? null) !== detail) families.push({ family, presence, detail });
  }
  if (families.length) patch.families = families;

  const nutrients: Record<string, unknown>[] = [];
  for (const code of NUTRIENTS) {
    if (!formData.has(`nut_${code}`)) continue;
    const raw = text(formData, `nut_${code}`);
    const now = draft.nutrients.find((n) => n.code === code);
    if (raw === undefined) {
      if (now && now.value !== null) nutrients.push({ code, value: "", missingReason: "not_provided" });
      continue;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new SocialError(422, "INVALID_PATCH");
    const method = text(formData, `nutmethod_${code}`) ?? "published";
    if (!now || now.value !== value || now.method !== method) nutrients.push({ code, value, method });
  }
  if (nutrients.length) patch.nutrients = nutrients;

  if (formData.get("reconfirm") === "on") patch.reconfirm = true;

  if (change.target.kind === "dish") {
    const price = num(formData, "priceDollars");
    const menuSection = text(formData, "menuSection");
    const serving = text(formData, "servingDescription");
    if (price !== undefined || menuSection || serving) {
      patch.dish = { menuSection: menuSection ?? null, priceCents: price === undefined ? null : Math.round(price * 100), servingDescription: serving ?? null };
    }
  }

  if (draft.recipe) {
    const recipe: Record<string, unknown> = {};
    const y = num(formData, "yieldServings");
    if (y !== undefined && y !== draft.recipe.yieldServings) recipe.yieldServings = y;
    const prep = num(formData, "prepMinutes");
    if ((prep ?? null) !== draft.recipe.prepMinutes) recipe.prepMinutes = prep ?? null;
    const cook = num(formData, "cookMinutes");
    if ((cook ?? null) !== draft.recipe.cookMinutes) recipe.cookMinutes = cook ?? null;
    const trial = text(formData, "trialCookedOn");
    if (trial && trial !== (draft.recipe.trialCookedAt ?? "").slice(0, 10)) recipe.trialCookedOn = trial;
    const steps = (text(formData, "steps") ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (formData.has("steps") && JSON.stringify(steps) !== JSON.stringify(draft.recipe.steps.map((s) => s.instruction))) {
      recipe.steps = steps.map((instruction) => ({ instruction }));
    }
    const rows: { foodItemId: string; grams: number }[] = [];
    for (let i = 0; i < 16; i++) {
      const id = idSchema.safeParse(formData.get(`ing_${i}`));
      const grams = num(formData, `inggrams_${i}`);
      if (id.success && grams !== undefined && grams > 0) rows.push({ foodItemId: id.data, grams });
    }
    const nowRows = draft.recipe.ingredients.map((i) => ({ foodItemId: i.foodItemId, grams: i.grams ?? i.quantity }));
    if (formData.has("ing_0") && JSON.stringify(rows) !== JSON.stringify(nowRows)) {
      recipe.ingredients = rows.map((r) => ({ foodItemId: r.foodItemId, quantity: r.grams, unit: "g", grams: r.grams }));
    }
    if (Object.keys(recipe).length) patch.recipe = recipe;
  }
  return patch;
}

export async function saveChangeAction(formData: FormData) {
  const id = idSchema.safeParse(formData.get("changeId"));
  await act(formData, id.success ? changePath(id.data) : "/editor", async () => {
    if (!id.success) return invalid();
    const intent = formData.get("intent");
    if (intent === "withdraw") {
      await editor.withdrawChange(id.data);
      return { to: "/editor", code: "change_withdrawn" };
    }
    const change = await editor.getChange(id.data);
    const patch = patchFrom(formData, change);
    // The source is saved first, so that statements in the same form can cite it.
    const { source, summary, ...rest } = patch;
    if (source !== undefined || summary !== undefined) await editor.saveChange(id.data, { ...(source !== undefined ? { source } : {}), ...(summary !== undefined ? { summary } : {}) });
    if (Object.keys(rest).length) await editor.saveChange(id.data, rest);
    // MAP-2: checked opening hours travel with the place change and are published only on approval.
    if (change.kind === "venue") {
      await editor.saveHours(id.data, formData.get("hoursOn") === "1" ? hoursFromForm((name) => text(formData, name)) : null);
    }
    if (intent === "submit") {
      await editor.submitChange(id.data);
      return "change_submitted";
    }
    return "change_saved";
  });
}

export async function reviewChangeAction(formData: FormData) {
  const id = idSchema.safeParse(formData.get("changeId"));
  await act(formData, id.success ? changePath(id.data) : "/editor", async () => {
    if (!id.success) return invalid();
    const decision = formData.get("decision") === "approve" ? "approve" : formData.get("decision") === "reject" ? "reject" : null;
    if (!decision) return invalid();
    await editor.reviewChange(id.data, decision, text(formData, "note"), formData.get("sourceChecked") === "on", formData.get("rightsOk") === "on");
    return decision === "approve" ? "change_published" : "change_rejected";
  });
}

export async function flagAction(formData: FormData) {
  await act(formData, "/editor/items", async () => {
    const food = idSchema.safeParse(formData.get("foodItemId"));
    const correction = idSchema.safeParse(formData.get("correctionId"));
    const reason = text(formData, "reason");
    if (!food.success) return invalid();
    if (!reason) throw new SocialError(422, "REASON_REQUIRED");
    await editor.flagNeedsReview(food.data, reason, correction.success ? correction.data : undefined);
    return "flagged";
  });
}

export async function suspensionAction(formData: FormData) {
  const handle = handleSchema.safeParse(formData.get("handle"));
  await act(formData, handle.success ? `/moderation/members/${handle.data}` : "/moderation", async () => {
    if (!handle.success) return invalid();
    const suspend = formData.get("suspend") === "1";
    await editor.setMemberSuspension(handle.data, suspend, text(formData, "reason"));
    return suspend ? "suspended" : "reinstated";
  });
}
