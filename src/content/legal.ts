/**
 * Privacy notice and terms for the invite-only foundation beta.
 *
 * DRAFT TEXT, written by Claude from what the code does, not legal advice and not approved. It follows the owner's
 * seven decisions of 26 Nov 2026 19:36 UTC (individual operator; adults only; Gmail sender; routine logs at most 30
 * days; consenting testers keep their data at public launch; a dedicated contact mailbox; the dietary, nutrition and
 * health baseline wording) and docs/99. While LEGAL_TEXT_APPROVED is false the pages say "Draft" and show each
 * `review` note as "For the owner's review"; the release preflight fails while it is false, while any review note is
 * left, or while no contact address is configured. Only the owner approves: a reviewed commit that settles every
 * review note and sets the flag to true, with CONTACT_EMAIL set in the hosting environment.
 *
 * Every sentence must stay true of the running service. Change the text, and LEGAL_VERSION, when the service changes:
 * a new version asks every member to agree again (migration 20261126000200, /welcome).
 */
export const LEGAL_TEXT_APPROVED = false;
export const LEGAL_VERSION = "draft-2026-11-26";

/**
 * The public contact address (owner decision 6: a dedicated project Gmail account, not created yet). It is read from
 * the CONTACT_EMAIL setting of the environment, never written here, and no made-up address is ever shown: until it is
 * set, the pages say that no contact address is active yet.
 */
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const configured = (process.env.CONTACT_EMAIL ?? "").trim().toLowerCase();
export const LEGAL_CONTACT: string | null = EMAIL.test(configured) && !/@example\.|\.(test|invalid|local)$/.test(configured) ? configured : null;
export const LEGAL_CONTACT_IS_PLACEHOLDER = LEGAL_CONTACT === null;
const contact = (what: string) =>
  LEGAL_CONTACT
    ? `${what}: email ${LEGAL_CONTACT}.`
    : `${what}: no contact address is active yet. One will be published here before anyone is invited.`;

/** `review`: a question only the owner (or a lawyer) can settle, shown on the draft page and removed before approval. */
export type LegalSection = { heading: string; paragraphs: string[]; review?: string[] };

export const PRIVACY: LegalSection[] = [
  {
    heading: "Who we are",
    paragraphs: [
      "Vegetarian Food Platform is an independently operated project. References to \"we,\" \"us,\" and \"our\" mean the individual responsible for operating the platform. It is not a company. It is a personal, non-commercial project: there are no ads, no fees, and nothing is sold.",
    ],
    review: [
      "No US law that applies to a small, free, invite-only project appears to require your full legal name in this notice, so it is left out. A lawyer should confirm this for your state before a public launch.",
    ],
  },
  {
    heading: "Who this is for",
    paragraphs: [
      "This is a small, invite-only test. You must be 18 or older to use it. Only people who were invited can create an account, and when you first sign in you are asked to confirm that you are 18 or older before you can use anything else. If we learn that an account belongs to someone under 18, we delete it.",
    ],
  },
  {
    heading: "What we collect",
    paragraphs: [
      "Your email address, so you can sign in with a one-time link. We never ask for a password. Before you join, your address is on the invite list, and it is removed from that list when you delete your account.",
      "Your confirmation that you are 18 or older, and which version of these terms and this notice you agreed to, with the time.",
      "What you choose to add: your diet choices and ingredient exclusions, the city you choose (saved to your account when you are signed in), diary entries, foods you create, goals, saved recipes, meals and places, cooking history, week plans, lists, reviews, ratings, and a display name and profile if you set one.",
      "Feedback you send about the test, stored under a short tester code instead of your name or email.",
      "Corrections and suggestions you send about restaurants, dishes and recipes (if these are open to you). The person running the test sees suggestions under a short contributor code, not your name or email. They are deleted with your account.",
      "Your time zone, kept in a small setting on your device and with each diary entry, so your diary days start and end at your own midnight.",
      "A scrambled form of your network address, kept for up to two days, so the service can slow down anyone sending too many requests. The real address is not stored in that record.",
      "Sign-in records kept by the sign-in service: the time of each sign-in or sign-out and the network address it came from. They are removed after 30 days.",
    ],
  },
  {
    heading: "What we do not collect",
    paragraphs: [
      "No advertising trackers, no third-party analytics and no session recording. We never sell your personal data or share it with advertisers.",
      "Cookies are used only to run the service, never for advertising or analytics: sign-in cookies that keep you signed in; one that remembers you have confirmed \"Before you start\"; your time zone; the city you chose; and, when you are not signed in, your diet filter and ingredient exclusions (once you sign in, your diet choice is saved to your account instead). Each lasts up to a year, and you can clear them in your browser at any time.",
      "We do not store your location. If you use \"near me\", your browser's location is used for that search only.",
      "The service's own error records contain only the kind of error, never your email, your diary or your food choices.",
    ],
  },
  {
    heading: "Who can see what",
    paragraphs: [
      "Your diary, goals, foods you create and nutrition totals are private to you. Being friends with someone never lets them see these.",
      "Lists, reviews and ratings are seen only by the audience you choose when you post them: only you, your friends, or everyone in the test. Every review starts private.",
      "The person running the test cannot read your diary through the app. There is no screen for it. They can read the feedback you send, by tester code, and the reviews and lists you share with everyone.",
    ],
  },
  {
    heading: "Services that handle your data",
    paragraphs: [
      "The website is hosted by Vercel and the database and sign-in by Supabase, both in the United States. Sign-in emails are sent through a Gmail account used only for this project, so Google handles your email address and the sign-in email. These services process data only to run the service.",
      "Their own technical logs can include your network address. On the free plans used for this test, Vercel keeps them for about 1 hour and Supabase for 1 day. Google keeps a copy of each sign-in email in the project mailbox's Sent folder until we delete it, which we do at least every 30 days.",
    ],
    review: [
      "Gmail saves every sign-in email it sends in the Sent folder, and that cannot be switched off. The sentence above commits you to emptying Sent (and Trash) at least every 30 days. Keep that promise, or change the wording.",
    ],
  },
  {
    heading: "Food information is not medical advice",
    paragraphs: [
      "Vegetarian Food Platform provides restaurant, ingredient, dietary and nutrition information from restaurant statements, published sources, user contributions and estimates. We work to present this information accurately, but menus, ingredients, recipes, preparation methods and portion sizes can change.",
      "A vegetarian, vegan or egg-free label is not a guarantee that a food is suitable for every individual. People with allergies, serious dietary restrictions or concerns about cross-contact should confirm ingredients and preparation practices directly with the restaurant.",
      "Nutrition information may include restaurant-published values or estimates derived from ingredient databases. Estimated values may differ from the actual food served and should not be treated as laboratory-verified measurements. When a value is not known, we say so rather than show a number.",
      "The platform provides general food and nutrition information, not individualized medical or dietetic advice. Seek qualified professional guidance for medical conditions or specialized dietary needs.",
    ],
  },
  {
    heading: "How long we keep it",
    paragraphs: [
      "Your account and what you add are kept until you delete them. Deleting something in your diary removes it for good within about 15 minutes.",
      "If the test becomes a public service, your account and what you added carry over, and you will be told beforehand and asked to agree to the updated terms and notice. You can export your data or delete your account instead.",
      "If the test ends for good, we will tell you by email where we can, give you 30 days to download your data, and then delete the accounts and their data.",
      "Backups: a copy of the database is made once a week and each copy is deleted after 4 weeks, so data you delete leaves every backup within 30 days. Backups are kept only on the operator's own computer, whose disk is encrypted.",
    ],
    review: [
      "The free Supabase plan makes no automatic backups. The backup sentence is true only if you run the weekly backup (docs/99 section 6: `node scripts/hosted-backup.mjs`, one command on your Mac; it checks FileVault is on and deletes copies older than 4 weeks). Agree to that routine, choose the paid plan's 7-day backups instead (about $25 a month), or remove the sentence and say there are no backups.",
    ],
  },
  {
    heading: "Your choices",
    paragraphs: [
      "You can download all of your data at any time from Goals, under \"Your data\": your diary, goals, foods, cooking and plans, saved items, profile, friends, reviews, lists, feedback, corrections and suggestions.",
      "You can delete your account from Account, then \"Delete your account\". Your private data, your feedback and your invite are removed from the live service right away. Copies in backups are removed when those backups expire, within 30 days.",
      contact("Questions, privacy requests or account deletion by email"),
    ],
  },
  {
    heading: "Changes",
    paragraphs: [
      "If this notice changes, its version changes and you are asked to read and agree to it again the next time you open the app. A change that affects how your data is used will be announced before it takes effect.",
    ],
  },
];

export const TERMS: LegalSection[] = [
  {
    heading: "Who runs this",
    paragraphs: [
      "Vegetarian Food Platform is an independently operated project. References to \"we,\" \"us,\" and \"our\" mean the individual responsible for operating the platform. It is free, non-commercial and invite-only.",
    ],
  },
  {
    heading: "A test, not a finished service",
    paragraphs: [
      "This is an invite-only test. Features may change, break or be removed, and the service may be unavailable at times or end. Please keep your own copy of anything important: you can download your data at any time.",
    ],
  },
  {
    heading: "Who can join",
    paragraphs: [
      "You must be 18 or older, and you need an invitation. One account per person, for your own use. Don't share your invitation or your sign-in links. Keep your email account secure, because sign-in links go there.",
    ],
  },
  {
    heading: "Food, nutrition and health",
    paragraphs: [
      "Restaurant, ingredient, dietary and nutrition information comes from restaurant statements, published sources, user contributions and estimates. Menus, ingredients, recipes, preparation methods and portion sizes can change.",
      "A vegetarian, vegan or egg-free label is not a guarantee that a food is suitable for every individual. If you have an allergy, a serious dietary restriction or concerns about cross-contact, confirm ingredients and preparation directly with the restaurant every time.",
      "Nutrition and protein figures may be restaurant-published values or estimates from ingredient databases, and estimates may differ from the food served. The platform provides general food and nutrition information, not individualized medical or dietetic advice.",
    ],
  },
  {
    heading: "Information from others",
    paragraphs: [
      "Some information comes from restaurants, public sources and other members. We show where each piece came from, but we do not control those sources and cannot promise they are complete or current.",
    ],
  },
  {
    heading: "What you post",
    paragraphs: [
      "You own what you write. By posting a review or list to an audience, you let the service show it to that audience until you delete it. Write only about your own experience. No harassment, hate, spam, private information about others, or fake reviews.",
      "Anything can be reported. The person running the test may hide content that breaks these rules, and may close an account that keeps breaking them.",
    ],
  },
  {
    heading: "No warranty, and limits on liability",
    paragraphs: [
      "The service is offered as it is, free of charge, without any promise that it is accurate, complete, available or fit for a particular purpose. To the extent the law allows, we are not responsible for losses arising from your use of the service or from relying on its information. Nothing in these terms limits rights you have under consumer protection law that cannot be waived.",
    ],
    review: [
      "This is a short, plain-language version of common wording. A lawyer should review it before a public launch, together with which state's law applies (these terms do not name one yet).",
    ],
  },
  {
    heading: "Ending",
    paragraphs: [
      "You can stop using the service and delete your account at any time. If we end the test, we will tell you where we can and give you 30 days to download your data first.",
    ],
  },
  {
    heading: "Contact",
    paragraphs: [contact("Support, corrections to restaurant, dietary or nutrition information, and privacy questions")],
  },
];

/** Every open review note, for the preflight and the readiness report. */
export const OPEN_REVIEW_NOTES = [...PRIVACY, ...TERMS].flatMap((s) => (s.review ?? []).map((r) => `${s.heading}: ${r}`));
