import { describe, expect, it } from "vitest";
import {
  handleSchema,
  listInputSchema,
  listItemsInputSchema,
  moderateInputSchema,
  profileInputSchema,
  profileSchema,
  reportInputSchema,
  reviewInputSchema,
  reviewSchema,
  targetHref,
  targetKindLabel,
  targetSchema,
} from "@/contracts/social";
import { DONE, REFUSED, refusal } from "@/components/social/messages";

// M5 input rules and wording (T-SOCIAL in docs/14). Who may see what is decided in the
// database and tested in tests/db/m5-social.test.ts and tests/rls/m5-social-privacy.test.ts.

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("handles", () => {
  it("accepts a typed @ and capitals, and stores the plain lowercase handle", () => {
    expect(handleSchema.parse("@Maya_Cooks")).toBe("maya_cooks");
    expect(handleSchema.parse("  abc  ")).toBe("abc");
  });
  it("refuses handles that are too short, too long or contain other characters", () => {
    for (const bad of ["ab", "a".repeat(31), "maya cooks", "maya-cooks", "<script>", "maya.cooks", ""]) {
      expect(handleSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe("profile form", () => {
  it("starts with everything optional switched off", () => {
    const p = profileInputSchema.parse({ handle: "maya" });
    expect(p).toMatchObject({ discoverable: false, showTastes: false, showDiet: false, tasteTags: [] });
  });
  it("limits tastes to eight short plain tags", () => {
    expect(profileInputSchema.parse({ handle: "maya", tasteTags: ["Spicy", "south indian", "tofu & tempeh"] }).tasteTags).toEqual(["spicy", "south indian", "tofu & tempeh"]);
    expect(profileInputSchema.safeParse({ handle: "maya", tasteTags: Array.from({ length: 9 }, (_, i) => `tag${i}`) }).success).toBe(false);
    expect(profileInputSchema.safeParse({ handle: "maya", tasteTags: ["<b>bold</b>"] }).success).toBe(false);
    expect(profileInputSchema.safeParse({ handle: "maya", tasteTags: ["x".repeat(25)] }).success).toBe(false);
  });
  it("limits the name and the bio", () => {
    expect(profileInputSchema.safeParse({ handle: "maya", displayName: "n".repeat(81) }).success).toBe(false);
    expect(profileInputSchema.safeParse({ handle: "maya", bio: "b".repeat(301) }).success).toBe(false);
  });
  it("has no field that could carry diary, goal or exclusion details on a public profile", () => {
    const keys = Object.keys(profileSchema.shape);
    for (const forbidden of ["exclusions", "goals", "diary", "protein", "calories", "email", "userId", "id"]) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });
});

describe("review form", () => {
  const base = { kind: "venue", targetId: id(1), rating: "4" };
  it("is private unless the member chooses otherwise", () => {
    expect(reviewInputSchema.parse(base)).toMatchObject({ rating: 4, audience: "private" });
  });
  it("accepts only whole ratings from 1 to 5", () => {
    for (const rating of ["0", "6", "3.5", "abc", "-1"]) {
      expect(reviewInputSchema.safeParse({ ...base, rating }).success, rating).toBe(false);
    }
  });
  it("accepts only restaurants and foods, never a diary entry or an own food kind", () => {
    expect(reviewInputSchema.safeParse({ ...base, kind: "food" }).success).toBe(true);
    for (const kind of ["diary", "custom_food", "recipe", "goal"]) {
      expect(reviewInputSchema.safeParse({ ...base, kind }).success, kind).toBe(false);
    }
  });
  it("limits the text and checks the visit date shape", () => {
    expect(reviewInputSchema.safeParse({ ...base, body: "x".repeat(2001) }).success).toBe(false);
    expect(reviewInputSchema.safeParse({ ...base, body: "x".repeat(2000) }).success).toBe(true);
    expect(reviewInputSchema.safeParse({ ...base, visitDate: "14/11/2026" }).success).toBe(false);
    expect(reviewInputSchema.safeParse({ ...base, visitDate: "2026-11-14" }).success).toBe(true);
  });
  it("refuses an audience that does not exist", () => {
    expect(reviewInputSchema.safeParse({ ...base, audience: "everyone" }).success).toBe(false);
  });
});

describe("lists, reports and moderation forms", () => {
  it("needs a list title and limits its length", () => {
    expect(listInputSchema.safeParse({ title: "   " }).success).toBe(false);
    expect(listInputSchema.safeParse({ title: "t".repeat(81) }).success).toBe(false);
    expect(listInputSchema.parse({ title: "  Date night  " }).title).toBe("Date night");
  });
  it("limits a list to 100 items", () => {
    const item = { kind: "venue", id: id(1) };
    expect(listItemsInputSchema.safeParse(Array.from({ length: 100 }, () => item)).success).toBe(true);
    expect(listItemsInputSchema.safeParse(Array.from({ length: 101 }, () => item)).success).toBe(false);
  });
  it("accepts only the listed report reasons", () => {
    expect(reportInputSchema.safeParse({ type: "review", id: id(1), reason: "spam" }).success).toBe(true);
    expect(reportInputSchema.safeParse({ type: "review", id: id(1), reason: "i dislike them" }).success).toBe(false);
    expect(reportInputSchema.safeParse({ type: "diary", id: id(1), reason: "spam" }).success).toBe(false);
  });
  it("accepts only approve, remove and restore as moderator decisions", () => {
    expect(moderateInputSchema.safeParse({ type: "list", id: id(1), action: "approve" }).success).toBe(true);
    expect(moderateInputSchema.safeParse({ type: "list", id: id(1), action: "delete" }).success).toBe(false);
    expect(moderateInputSchema.safeParse({ type: "list", id: id(1), action: "publish_all" }).success).toBe(false);
  });
});

describe("what a shared item can point at", () => {
  it("links restaurants, recipes and foods to their own pages", () => {
    expect(targetHref({ kind: "venue", id: id(1) })).toBe(`/venues/${id(1)}`);
    expect(targetHref({ kind: "recipe", id: id(2) })).toBe(`/cook/${id(2)}`);
    expect(targetHref({ kind: "venue", id: id(1), placeSlug: "heron-cafe" })).toBe("/places/heron-cafe");
    expect(targetHref({ kind: "dish", id: id(3) })).toBe(`/foods/${id(3)}`);
    expect(targetHref({ kind: "packaged", id: id(4) })).toBe(`/foods/${id(4)}`);
  });
  it("keeps restaurant and dish wording distinct", () => {
    expect(targetKindLabel("venue")).toBe("Restaurant");
    expect(targetKindLabel("dish")).toBe("Dish");
  });
  it("cannot describe an own (custom) food", () => {
    expect(targetSchema.safeParse({ kind: "custom", id: id(1), name: "My shake", isDemo: false }).success).toBe(false);
  });
  it("refuses a review with a rating outside 1 to 5 coming back from the database", () => {
    const review = {
      reviewId: id(1), rating: 9, body: null, visitDate: null, audience: "public", state: "visible", version: 1,
      createdAt: "x", updatedAt: "x", publishedAt: null, edited: false, isMine: false, author: null, target: null,
    };
    expect(reviewSchema.safeParse(review).success).toBe(false);
    expect(reviewSchema.safeParse({ ...review, rating: 5 }).success).toBe(true);
  });
});

describe("messages", () => {
  it("says honestly that a first public post waits for a moderator", () => {
    for (const key of ["review_pending", "ranking_pending", "list_pending"]) {
      expect(DONE[key], key).toMatch(/moderator/i);
      expect(DONE[key], key).not.toMatch(/is public\b/i);
    }
  });
  it("falls back to a general message for an unknown refusal and is empty when nothing went wrong", () => {
    expect(refusal("SOMETHING_NEW")).toBe(REFUSED.INVALID_REQUEST);
    expect(refusal(undefined)).toBe("");
    expect(refusal("RATE_LIMITED")).toMatch(/wait/i);
  });
  it("never shows a raw code, a database word or a blaming tone to a member", () => {
    for (const text of [...Object.values(DONE), ...Object.values(REFUSED)]) {
      expect(text).not.toMatch(/[A-Z]{3,}_[A-Z]+|PT4\d\d|sql|rpc|null|undefined/);
      expect(text).not.toMatch(/\b(failed|illegal|violation|banned|bad)\b/i);
    }
  });
});
