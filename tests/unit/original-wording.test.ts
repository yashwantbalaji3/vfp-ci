import { describe, expect, it } from "vitest";
import { findDishExcerpts, findExcerpts, fold, foldWithMap, htmlToText, nameVariants } from "@/contracts/original-wording";

// The menu's own words beside a draft (owner directive 27 Nov 2026). Invented menu text, never a real restaurant's.
describe("original menu wording", () => {
  it("reads a saved HTML page as plain text", () => {
    const html = `<html><head><style>.x{color:red}</style><script>var a = "<b>Not this</b>";</script></head>
      <body><h2>Mains</h2><div class="item"><b>Lantern Tofu</b> &ndash; $12.50<br>Crisp tofu &amp; greens</div><!-- hidden --></body></html>`;
    expect(htmlToText(html)).toBe("Mains\nLantern Tofu – $12.50\nCrisp tofu & greens");
  });

  it("matches a dish name whatever its case, accents or punctuation", () => {
    expect(fold("Phở  Bún-Chay")).toBe("pho bun chay");
    expect(fold("Xi'an Cold Noodles")).toBe("xi an cold noodles");
    const text = "Soups\n90. BÚN CÀ RY CHAY . . . . . . . . $15.00 Vegetable & tofu curry soup.";
    const [e] = findExcerpts(text, "Bún Cà Ry Chay");
    expect(e.match).toBe("BÚN CÀ RY CHAY");
    expect(e.after).toBe(" … $15.00 Vegetable & tofu curry soup.");
  });

  it("finds whole words only, at most twice, and keeps what comes after the name", () => {
    const text = "Tofu Bowlful $9. Tofu Bowl $11 with rice. Later: Tofu Bowl again. And Tofu Bowl a third time.";
    const hits = findExcerpts(text, "tofu bowl", { afterChars: 12 });
    expect(hits).toHaveLength(2);
    expect(hits[0].match).toBe("Tofu Bowl");
    expect(hits[0].after.startsWith(" $11 with ri")).toBe(true);
    expect(findExcerpts(text, "Bowlf")).toEqual([]);
    expect(findExcerpts(text, "to")).toEqual([]); // too short to mean anything
  });

  it("works from a page folded once, for many dishes", () => {
    const page = foldWithMap("Starters: Samosa Chaat $8. Mains: Aloo Matar (vegan) $13.95 Green peas and potatoes.");
    expect(findExcerpts(page, "aloo matar")[0].after).toContain("(vegan) $13.95");
    expect(findExcerpts(page, "Samosa Chaat")[0].before).toBe("Starters: ");
    expect(findExcerpts(page, "Paneer Tikka")).toEqual([]);
  });

  it("finds a drafted name that joins the menu's two lines or two choices", () => {
    const text = "Soups\n7. CANH LANTERN CHAY . . . . $12.00\nLANTERN TOFU SOUP\nTofu and greens.\n8. COM SEN hoặc XOI SEN . . $9";
    expect(findExcerpts(text, "Canh Lantern Chay (Lantern Tofu Soup)")).toEqual([]);
    expect(findDishExcerpts(text, "Canh Lantern Chay (Lantern Tofu Soup)")[0].match).toBe("CANH LANTERN CHAY");
    expect(findDishExcerpts(text, "Xoi Sen or Com Sen (Lotus Rice)")[0].match).toBe("XOI SEN");
    expect(nameVariants("Gỏi Cuốn Chay (Fresh Roll, 2 rolls)")).toEqual(["Gỏi Cuốn Chay (Fresh Roll, 2 rolls)", "Gỏi Cuốn Chay", "Fresh Roll, 2 rolls", "Fresh Roll"]);
    expect(nameVariants("Shiro")).toEqual(["Shiro"]); // the full name always counts, however short
    expect(findDishExcerpts(text, "Tofu (Bowl)")).toEqual([]); // "Tofu" or "Bowl" alone would match too much
  });
});
