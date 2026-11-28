import { describe, expect, it } from "vitest";
import { DIETARY_PRESETS, qualifiesForStrictResults, strictResultGroup } from "@/domain/dietary/families";

describe("dietary presets (docs/18)", () => {
  it("offers an egg-free vegetarian preset that keeps dairy allowed", () => {
    const preset = DIETARY_PRESETS.find((p) => p.id === "egg-free-vegetarian")!;
    expect(preset.diet).toBe("vegetarian");
    expect(preset.exclusions).toEqual(["egg"]);
    expect(preset.explanation).toMatch(/Dairy stays allowed/);
  });

  it("never lets 'needs confirmation' into strict results", () => {
    expect(qualifiesForStrictResults("eligible", false)).toBe(true);
    expect(qualifiesForStrictResults("needs_confirmation", true)).toBe(false);
    expect(qualifiesForStrictResults("excluded", true)).toBe(false);
    expect(qualifiesForStrictResults("conditional", false)).toBe(false);
    expect(qualifiesForStrictResults("conditional", true)).toBe(true);
  });

  it("groups results: confirmed matches by default, unknown only behind 'Needs confirmation', contains always hidden", () => {
    expect(strictResultGroup("eligible", false)).toBe("match");
    expect(strictResultGroup("needs_confirmation", false)).toBe("needs_confirmation");
    expect(strictResultGroup("needs_confirmation", true)).toBe("needs_confirmation");
    expect(strictResultGroup("excluded", true)).toBe("hidden");
    // A dish that is only suitable with a change is not a confirmed match unless the person opted in.
    expect(strictResultGroup("conditional", false)).toBe("needs_confirmation");
    expect(strictResultGroup("conditional", true)).toBe("match");
  });
});
