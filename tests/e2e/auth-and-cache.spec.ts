import { expect, test, type BrowserContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { confirmWelcome } from "./helpers";

/**
 * Cross-user caching and session safety (docs/10, docs/12, docs/14).
 * Two members sign in with real magic links (captured by the local mail server)
 * in separate browser contexts; neither may ever receive the other's data,
 * and no private response may be cacheable.
 */
function localEnv(name: string, fallback: string): string {
  if (process.env[name]) return process.env[name]!;
  if (existsSync(".env.local")) {
    const m = readFileSync(".env.local", "utf8").match(new RegExp(`^${name}=(.*)$`, "m"));
    if (m) return m[1];
  }
  return fallback;
}
const MAILPIT = localEnv("MAILPIT_URL", "http://127.0.0.1:54324");

async function magicLinkFor(email: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const search = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
    const body = (await search.json()) as { messages?: { ID: string }[] };
    if (body.messages?.length) {
      const msg = await (await fetch(`${MAILPIT}/api/v1/message/${body.messages[0].ID}`)).json();
      const text: string = msg.Text ?? msg.HTML ?? "";
      const link = text.match(/https?:\/\/[^\s"<>)\]]+/g)?.find((l) => l.includes("/auth/v1/verify"));
      if (link) return link.replace(/&amp;/g, "&");
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`No magic link email arrived for ${email}`);
}

async function signIn(context: BrowserContext, email: string) {
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("status").filter({ hasText: "a link is on its way" })).toBeVisible();
  await page.goto(await magicLinkFor(email));
  await confirmWelcome(page);
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByTestId("signed-in-as")).toContainText(email);
  return page;
}

test("two members never see each other's identity, and private responses are not cacheable", async ({ browser }) => {
  const emailA = `e2e-a-${randomUUID().slice(0, 8)}@example.test`;
  const emailB = `e2e-b-${randomUUID().slice(0, 8)}@example.test`;
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const ctxGuest = await browser.newContext();

  const pageA = await signIn(ctxA, emailA);
  const pageB = await signIn(ctxB, emailB);

  // Interleave requests: a shared cache would hand one member the other's response.
  const meA1 = await ctxA.request.get("/api/v1/me");
  const meB1 = await ctxB.request.get("/api/v1/me");
  const meA2 = await ctxA.request.get("/api/v1/me");
  const idA = (await meA1.json()).data.userId;
  const idB = (await meB1.json()).data.userId;
  expect(idA).not.toBe(idB);
  expect((await meA2.json()).data.userId).toBe(idA);
  for (const res of [meA1, meB1, meA2]) {
    expect(res.headers()["cache-control"]).toContain("no-store");
    expect(res.headers()["cache-control"]).toContain("private");
  }

  // The account page is private and per-member.
  const accountA = await pageA.goto("/account");
  expect(accountA?.headers()["cache-control"]).toContain("no-store");
  await expect(pageA.getByTestId("signed-in-as")).toContainText(emailA);
  await pageB.goto("/account");
  await expect(pageB.getByTestId("signed-in-as")).toContainText(emailB);
  await expect(pageB.getByTestId("signed-in-as")).not.toContainText(emailA);

  // A guest right after both members gets nothing private.
  const guestMe = await ctxGuest.request.get("/api/v1/me");
  expect(guestMe.status()).toBe(401);
  expect(guestMe.headers()["cache-control"]).toContain("no-store");
  const guestPage = await ctxGuest.newPage();
  await guestPage.goto("/account");
  await expect(guestPage.getByText("not signed in")).toBeVisible();
  await expect(guestPage.locator("body")).not.toContainText(emailA);
  await expect(guestPage.locator("body")).not.toContainText(emailB);

  // Signing out ends access.
  await pageA.getByRole("button", { name: "Sign out" }).click();
  await expect(pageA).toHaveURL(/\/discover$/);
  expect((await ctxA.request.get("/api/v1/me")).status()).toBe(401);
});

test("login redirect only allows same-site relative destinations", async ({ request }) => {
  for (const next of ["//evil.example", "https://evil.example", "/\\evil.example"]) {
    const res = await request.get(`/auth/callback?code=bogus&next=${encodeURIComponent(next)}`, { maxRedirects: 0 });
    expect(res.status()).toBe(307);
    expect(res.headers()["location"]).toMatch(/^(http:\/\/localhost:3000)?\/login\?error=link$/);
  }
});

test("security headers are present and the site is not indexable", async ({ page }) => {
  const res = await page.goto("/");
  const h = res!.headers();
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["x-frame-options"]).toBe("DENY");
  expect(h["x-powered-by"]).toBeUndefined();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  await expect(page.getByRole("note")).toContainText("invented for testing");
});
