import { expect, test } from "@playwright/test";

// Verifies the approved contrast fixes (D-D1, 2026-11-13) in rendered components, not just in tokens.
// WCAG 2.2: text >= 4.5:1 (1.4.3); control boundaries and focus indicators >= 3:1 (1.4.11).

function parse(rgb: string): [number, number, number] {
  const m = rgb.match(/\d+(\.\d+)?/g);
  if (!m) throw new Error(`cannot parse colour ${rgb}`);
  return [Number(m[0]), Number(m[1]), Number(m[2])];
}
function luminance([r, g, b]: [number, number, number]) {
  const c = [r, g, b].map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function ratio(a: string, b: string) {
  const [x, y] = [luminance(parse(a)), luminance(parse(b))].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

test("sign-in form meets the approved contrast rules", async ({ page }) => {
  await page.goto("/login");
  const body = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const input = page.locator('input[type="email"]');
  const inputStyle = await input.evaluate((el) => {
    const s = getComputedStyle(el);
    return { border: s.borderTopColor, bg: s.backgroundColor, color: s.color };
  });
  expect(ratio(inputStyle.border, body)).toBeGreaterThanOrEqual(3);
  expect(ratio(inputStyle.border, inputStyle.bg)).toBeGreaterThanOrEqual(3);
  expect(ratio(inputStyle.color, inputStyle.bg)).toBeGreaterThanOrEqual(4.5);

  const button = page.getByRole("button").first();
  const btn = await button.evaluate((el) => {
    const s = getComputedStyle(el);
    return { color: s.color, bg: s.backgroundColor };
  });
  expect(ratio(btn.color, btn.bg)).toBeGreaterThanOrEqual(4.5);

  // Focus indicator uses the darker accent and is visible against the page.
  await input.focus();
  await page.keyboard.press("Tab");
  await input.focus();
  const outline = await input.evaluate((el) => getComputedStyle(el).outlineColor);
  expect(ratio(outline, body)).toBeGreaterThanOrEqual(3);

  // Small accent text token resolves to the approved darker value.
  const accentText = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent-text").trim());
  expect(accentText.toLowerCase()).toBe("#a84a2c");
});
