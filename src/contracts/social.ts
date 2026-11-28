import { z } from "zod";

/**
 * Social contracts (M5). Shapes returned by the social database functions and the
 * inputs the screens and API accept. Nothing here can carry a diary entry, a goal,
 * a nutrition total, an own food, a plan or a cook session: the fields do not exist.
 */
export const HANDLE_PATTERN = /^[a-z0-9_]{3,30}$/;
export const handleSchema = z
  .string()
  .trim()
  .toLowerCase()
  .transform((s) => s.replace(/^@/, ""))
  .pipe(z.string().regex(HANDLE_PATTERN, "Use 3 to 30 lowercase letters, numbers or underscores."));

export const AUDIENCES = ["private", "friends", "public"] as const;
export type Audience = (typeof AUDIENCES)[number];
export const PUBLICATION_STATES = ["draft", "pending", "visible", "removed"] as const;
export type PublicationState = (typeof PUBLICATION_STATES)[number];
export const REPORT_REASONS = ["spam", "harassment", "false_information", "unsafe_dietary_claim", "other"] as const;
export const REPORT_REASON_LABELS: Record<(typeof REPORT_REASONS)[number], string> = {
  spam: "Spam or advertising",
  harassment: "Harassment or abuse",
  false_information: "False information",
  unsafe_dietary_claim: "Unsafe dietary or allergy claim",
  other: "Something else",
};
export const SOCIAL_VIEWS = ["matches", "needs_confirmation"] as const;
export type SocialView = (typeof SOCIAL_VIEWS)[number];

const uuid = z.string().uuid();
const when = z.string();

export const personSchema = z.object({ handle: z.string(), displayName: z.string(), isDemo: z.boolean() });
export type Person = z.infer<typeof personSchema>;

const eligibilitySchema = z
  .object({ status: z.enum(["eligible", "conditional", "needs_confirmation", "excluded"]) })
  .passthrough();
export const targetSchema = z.object({
  kind: z.enum(["venue", "dish", "recipe", "packaged"]),
  id: uuid,
  name: z.string(),
  isDemo: z.boolean(),
  neighborhood: z.string().nullish(),
  venueId: uuid.nullish(),
  venueName: z.string().nullish(),
  eligibility: eligibilitySchema.nullish(),
  /** A real place's page (docs/49); set only for a venue that is a real place's app record. */
  placeSlug: z.string().max(120).nullish(),
});
export type SocialTarget = z.infer<typeof targetSchema>;

export const reviewSchema = z.object({
  reviewId: uuid,
  rating: z.number().int().min(1).max(5),
  body: z.string().nullable(),
  visitDate: z.string().nullable(),
  audience: z.enum(AUDIENCES),
  state: z.enum(PUBLICATION_STATES),
  version: z.number().int(),
  createdAt: when,
  updatedAt: when,
  publishedAt: when.nullable(),
  edited: z.boolean(),
  isMine: z.boolean(),
  author: personSchema.nullable(),
  target: targetSchema.nullable(),
});
export type Review = z.infer<typeof reviewSchema>;

export const ratingSummarySchema = z.object({ count: z.number().int(), average: z.number().nullable(), early: z.boolean() });
export type RatingSummary = z.infer<typeof ratingSummarySchema>;
export const targetReviewsSchema = z.object({ target: targetSchema, summary: ratingSummarySchema, mine: reviewSchema.nullable(), reviews: z.array(reviewSchema) });
export type TargetReviews = z.infer<typeof targetReviewsSchema>;
export const myReviewsSchema = z.object({ reviews: z.array(reviewSchema) });

export const listItemSchema = z.object({ itemId: uuid, position: z.number().int(), note: z.string().nullable(), target: targetSchema });
export type ListItem = z.infer<typeof listItemSchema>;
export const listSummarySchema = z.object({
  listId: uuid,
  title: z.string(),
  description: z.string().nullable(),
  visibility: z.enum(["private", "public"]),
  state: z.enum(PUBLICATION_STATES),
  isEditorial: z.boolean(),
  isMine: z.boolean(),
  updatedAt: when,
  publishedAt: when.nullable(),
  itemCount: z.number().int(),
  owner: personSchema.nullable(),
});
export type ListSummary = z.infer<typeof listSummarySchema>;
export const listViewSchema = listSummarySchema.extend({ items: z.array(listItemSchema), needsConfirmationCount: z.number().int() });
export type ListView = z.infer<typeof listViewSchema>;
export const myListsSchema = z.object({ lists: z.array(listSummarySchema) });
export const collectionsSchema = z.object({ collections: z.array(listSummarySchema) });

const rankedVenueSchema = z.object({ position: z.number().int(), venueId: uuid, name: z.string(), neighborhood: z.string().nullable(), isDemo: z.boolean() });
export const rankingPublicationSchema = z.object({
  publicationId: uuid,
  publishedAt: when,
  state: z.enum(["pending", "visible", "removed"]),
  isMine: z.boolean(),
  entries: z.array(rankedVenueSchema),
  owner: personSchema.nullable(),
});
export type RankingPublication = z.infer<typeof rankingPublicationSchema>;
export const myRankingSchema = z.object({
  entries: z.array(rankedVenueSchema),
  unranked: z.array(rankedVenueSchema.omit({ position: true })),
  publication: rankingPublicationSchema.nullable(),
});
export type MyRanking = z.infer<typeof myRankingSchema>;

export const profileSchema = z.object({
  handle: z.string(),
  displayName: z.string(),
  bio: z.string().nullable(),
  isDemo: z.boolean(),
  tastes: z.array(z.string()).nullable(),
  diet: z.string().nullable(),
  followerCount: z.number().int(),
  followingCount: z.number().int(),
  joined: z.string(),
});
export const FRIENDSHIP_STATES = ["none", "outgoing", "incoming", "friends"] as const;
export const profileViewSchema = z.object({
  profile: profileSchema,
  isMe: z.boolean(),
  relationship: z
    .object({ following: z.boolean(), followsMe: z.boolean(), friendship: z.enum(FRIENDSHIP_STATES), canRequestFriend: z.boolean() })
    .nullable(),
  reviews: z.array(reviewSchema),
  needsConfirmationCount: z.number().int(),
  ranking: rankingPublicationSchema.nullable(),
  lists: z.array(listSummarySchema),
});
export type ProfileView = z.infer<typeof profileViewSchema>;

export const myProfileSchema = z.object({
  profile: z
    .object({
      handle: z.string(),
      displayName: z.string().nullable(),
      bio: z.string().nullable(),
      tasteTags: z.array(z.string()),
      discoverable: z.boolean(),
      showTastes: z.boolean(),
      showDiet: z.boolean(),
      followerCount: z.number().int(),
      followingCount: z.number().int(),
    })
    .nullable(),
  firstPublicApproved: z.boolean(),
  profileHidden: z.boolean(),
  incomingRequests: z.number().int(),
  isModerator: z.boolean(),
  isCurator: z.boolean(),
});
export type MyProfile = z.infer<typeof myProfileSchema>;

const people = z.array(personSchema);
export const connectionsSchema = z.object({ following: people, followers: people, friends: people, incoming: people, outgoing: people, blocked: people });
export type Connections = z.infer<typeof connectionsSchema>;
export const findPeopleSchema = z.object({ results: people });
export const suggestedPeopleSchema = z.object({ people: z.array(personSchema.extend({ publicReviews: z.number().int() })) });

export const feedItemSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("review"), at: when, item: reviewSchema }),
  z.object({ type: z.literal("list"), at: when, item: listSummarySchema }),
  z.object({ type: z.literal("ranking"), at: when, item: rankingPublicationSchema }),
]);
export type FeedItem = z.infer<typeof feedItemSchema>;
export const feedSchema = z.object({
  feed: z.enum(["following", "friends"]),
  items: z.array(feedItemSchema),
  needsConfirmationCount: z.number().int(),
  nextBefore: when.nullable(),
});
export type Feed = z.infer<typeof feedSchema>;

const recommendationSchema = z.object({
  target: targetSchema,
  reasons: z.array(z.object({ person: personSchema, rating: z.number().int(), audience: z.enum(["public", "friends"]).optional() })),
  count: z.number().int(),
});
export type Recommendation = z.infer<typeof recommendationSchema>;
export const recommendationsSchema = z.object({
  venues: z.array(recommendationSchema),
  dishes: z.array(recommendationSchema),
  needsConfirmationCount: z.number().int(),
  followingCount: z.number().int(),
});
export type Recommendations = z.infer<typeof recommendationsSchema>;

export const moderationTargetSchema = z.object({
  type: z.enum(["review", "list", "ranking", "profile"]),
  id: uuid,
  author: personSchema.nullable(),
  audience: z.string(),
  state: z.string(),
  at: when.nullable(),
  firstPost: z.boolean(),
  rating: z.number().int().optional(),
  title: z.string().nullish(),
  body: z.string().nullish(),
  target: targetSchema.nullish(),
  items: z.array(listItemSchema).optional(),
  entries: z.array(rankedVenueSchema).optional(),
});
export type ModerationTarget = z.infer<typeof moderationTargetSchema>;
export const moderationQueueSchema = z.object({
  pending: z.array(moderationTargetSchema),
  reports: z.array(
    z.object({
      reportId: uuid,
      reason: z.enum(REPORT_REASONS),
      details: z.string().nullable(),
      at: when,
      sameTargetCount: z.number().int(),
      target: moderationTargetSchema.nullable(),
    }),
  ),
  removed: z.array(moderationTargetSchema.nullable()),
  log: z.array(z.object({ action: z.string(), type: z.string(), reason: z.string().nullable(), at: when })),
});
export type ModerationQueue = z.infer<typeof moderationQueueSchema>;

const correctionSchema = z.object({
  correctionId: uuid,
  field: z.string(),
  proposedValue: z.string(),
  evidenceNote: z.string().nullish(),
  state: z.string().optional(),
  decisionNote: z.string().nullish(),
  at: when.nullable(),
  target: targetSchema.nullable(),
  foodItemId: uuid.nullish(),
  venueId: uuid.nullish(),
  appliedChangeId: uuid.nullish(),
  openChangeId: uuid.nullish(),
});
export const correctionsQueueSchema = z.object({ open: z.array(correctionSchema), decided: z.array(correctionSchema) });
export type CorrectionsQueue = z.infer<typeof correctionsQueueSchema>;

export const writeSchema = z.record(z.string(), z.unknown());

/* ---- inputs ---- */
const tasteTag = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9 &-]{0,23}$/, "Tastes use letters, numbers, spaces, & and -, up to 24 characters each.");
export const profileInputSchema = z.object({
  handle: handleSchema,
  displayName: z.string().trim().max(80, "Keep the name to 80 characters.").optional(),
  bio: z.string().trim().max(300, "Keep this to 300 characters.").optional(),
  tasteTags: z.array(tasteTag).max(8, "Choose up to 8 tastes.").default([]),
  discoverable: z.boolean().default(false),
  showTastes: z.boolean().default(false),
  showDiet: z.boolean().default(false),
});
export type ProfileInput = z.infer<typeof profileInputSchema>;

export const targetKindSchema = z.enum(["venue", "food"]);
export type TargetKind = z.infer<typeof targetKindSchema>;
export const reviewInputSchema = z.object({
  kind: targetKindSchema,
  targetId: uuid,
  rating: z.coerce.number().int("Choose a rating from 1 to 5.").min(1, "Choose a rating from 1 to 5.").max(5, "Choose a rating from 1 to 5."),
  body: z.string().trim().max(2000, "Keep the review to 2,000 characters.").optional(),
  visitDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-14.")
    .optional(),
  audience: z.enum(AUDIENCES).default("private"),
  expectedVersion: z.coerce.number().int().positive().optional(),
});
export type ReviewInput = z.infer<typeof reviewInputSchema>;

export const listInputSchema = z.object({
  listId: uuid.optional(),
  title: z.string().trim().min(1, "Give the list a title.").max(80, "Keep the title to 80 characters."),
  description: z.string().trim().max(500, "Keep the description to 500 characters.").optional(),
});
export const listItemsInputSchema = z
  .array(z.object({ kind: targetKindSchema, id: uuid, note: z.string().trim().max(200).optional() }))
  .max(100);
export type ListItemsInput = z.infer<typeof listItemsInputSchema>;

export const reportInputSchema = z.object({
  type: z.enum(["review", "list", "ranking", "profile"]),
  id: uuid.optional(),
  handle: handleSchema.optional(),
  reason: z.enum(REPORT_REASONS),
  details: z.string().trim().max(500).optional(),
});
export type ReportInput = z.infer<typeof reportInputSchema>;

export const moderateInputSchema = z.object({
  type: z.enum(["review", "list", "ranking", "profile"]),
  id: uuid,
  action: z.enum(["approve", "remove", "restore"]),
  reason: z.string().trim().max(300).optional(),
});
export type ModerateInput = z.infer<typeof moderateInputSchema>;

/** Where a restaurant, dish or recipe lives in the app. */
export function targetHref(t: Pick<SocialTarget, "kind" | "id"> & { placeSlug?: string | null }): string {
  if (t.kind === "venue" && t.placeSlug) return `/places/${t.placeSlug}`;
  return t.kind === "venue" ? `/venues/${t.id}` : t.kind === "recipe" ? `/cook/${t.id}` : `/foods/${t.id}`;
}
export const targetKindLabel = (kind: SocialTarget["kind"]) =>
  kind === "venue" ? "Restaurant" : kind === "recipe" ? "Recipe" : kind === "packaged" ? "Packaged food" : "Dish";
