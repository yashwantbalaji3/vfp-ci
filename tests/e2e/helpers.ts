import { expect, type BrowserContext, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";

export function localEnv(name: string, fallback: string): string {
  if (process.env[name]) return process.env[name]!;
  if (existsSync(".env.local")) {
    const m = readFileSync(".env.local", "utf8").match(new RegExp(`^${name}=(.*)$`, "m"));
    if (m) return m[1];
  }
  return fallback;
}
const MAILPIT = localEnv("MAILPIT_URL", "http://127.0.0.1:54324");

/** Reads the real sign-in email from the local mail catcher. */
async function inbox(email: string): Promise<{ ID: string }[]> {
  const search = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
  return ((await search.json()) as { messages?: { ID: string }[] }).messages ?? [];
}

/** `after` is how many emails this address already had, so a second sign-in waits for its own new link. */
export async function magicLinkFor(email: string, after = 0): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const body = { messages: await inbox(email) };
    if (body.messages.length > after) {
      const msg = await (await fetch(`${MAILPIT}/api/v1/message/${body.messages[0].ID}`)).json();
      const text: string = msg.Text ?? msg.HTML ?? "";
      const link = text.match(/https?:\/\/[^\s"<>)\]]+/g)?.find((l) => l.includes("/auth/v1/verify"));
      if (link) return link.replace(/&amp;/g, "&");
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`No magic link email arrived for ${email}`);
}

/**
 * The sign-in service sends one link per address per second (auth.email.max_frequency) and the
 * form answers the same either way, so a test that signs the same person in twice waits its turn.
 */
const lastLinkRequest = new Map<string, number>();
const LINK_SPACING_MS = 1500;

/** Fills the sign-in form on the current page and follows the emailed link. */
export async function completeSignIn(page: Page, email: string) {
  const wait = (lastLinkRequest.get(email) ?? 0) + LINK_SPACING_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const already = (await inbox(email)).length;
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("status").filter({ hasText: "a link is on its way" })).toBeVisible();
  lastLinkRequest.set(email, Date.now());
  await page.goto(await magicLinkFor(email, already));
  await confirmWelcome(page);
}

/** Adults-only beta (migration 20261126000200): a new member confirms "Before you start" once, then goes where they were headed. */
export async function confirmWelcome(page: Page) {
  if (!new URL(page.url()).pathname.startsWith("/welcome")) return;
  await page.getByLabel("I am 18 or older.").check();
  await page.getByLabel(/I have read and agree to the/).check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/welcome"));
}

/** The visitor's dietary filter, set the way the app stores it. */
export async function setDiet(context: BrowserContext, diet: "none" | "vegetarian" | "vegan", exclusions: string[] = [], includeConditional = false) {
  await context.addCookies([
    { name: "diet_pref", value: JSON.stringify({ diet, exclusions, includeConditional }), domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
}

/** WCAG 1.4.10 reflow: the page itself must not scroll sideways. */
export async function expectNoSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `page is ${overflow}px wider than the screen at ${page.url()}`).toBeLessThanOrEqual(1);
}

export const FOOD = {
  bowl: "00000000-0000-4000-8000-000000000201",
  tofu: "00000000-0000-4000-8000-000000000101",
  crispbread: "00000000-0000-4000-8000-000000001001",
  lentils: "00000000-0000-4000-8000-000000001101",
  stock: "00000000-0000-4000-8000-000000001201",
  peanutNoodles: "00000000-0000-4000-8000-000000002001",
  bibimbap: "00000000-0000-4000-8000-000000001601",
  tempeh: "00000000-0000-4000-8000-000000001901",
};
export const VENUE = { central: "00000000-0000-4000-8000-00000000c001" };
