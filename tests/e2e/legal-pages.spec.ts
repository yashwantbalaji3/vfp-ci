import { expect, test } from "@playwright/test";
import { expectNoSidewaysScroll } from "./helpers";

/**
 * The privacy notice and terms (owner 23 Nov 2026 17:49 UTC, Track A): readable signed out, linked from sign-in, and
 * marked "Draft" until the owner approves the wording (src/content/legal.ts).
 */
for (const [path, id, heading] of [["/privacy", "privacy-text", "Privacy"], ["/terms", "terms-text", "Terms"]] as const) {
  test(`${heading} is readable signed out and says it is a draft`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await expect(page.getByTestId(id)).toBeVisible();
    await expect(page.getByTestId("legal-draft")).toContainText("Draft for review");
    // Each question only the owner can settle is shown on the draft.
    await expect(page.getByTestId("legal-review").first()).toContainText("For the owner’s review");
    await expectNoSidewaysScroll(page);
  });
}

test("sign-in links to the privacy notice and the terms", async ({ page }) => {
  await page.goto("/login");
  const links = page.getByTestId("legal-links");
  await expect(links.getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "/privacy");
  await expect(links.getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");
});
