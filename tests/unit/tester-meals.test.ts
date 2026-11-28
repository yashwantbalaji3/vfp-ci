import { describe, expect, it } from "vitest";
import { areaProgress, failing, testerState, type TesterChecks } from "@/contracts/tester-meals";

const pass: TesterChecks = { meal: true, rights: true, stated: true, statedDiets: ["vegan"], place: true, fresh: true, price: true, open: true, reviewed: true, reviewedDiets: ["vegan"], checkedOn: "2026-11-20" };

describe("tester meal states", () => {
  it("is ready only when every check passes and nobody left it out", () => {
    expect(testerState({ checks: pass, decision: null, included: false })).toBe("ready");
    expect(testerState({ checks: pass, decision: "leave_out", included: false })).toBe("left_out");
    expect(testerState({ checks: pass, decision: "include", included: true })).toBe("included");
    expect(testerState({ checks: { ...pass, price: false }, decision: null, included: false })).toBe("not_eligible");
    expect(failing({ ...pass, stated: false, fresh: false })).toEqual(["stated", "fresh"]);
  });
});

describe("progress against the launch minimum", () => {
  const places = [
    { placeId: "a", area: "Cambridge", cuisines: [{ cuisine: "indian", basis: "primary" }] },
    { placeId: "b", area: "Cambridge", cuisines: [{ cuisine: "thai", basis: "primary" }] },
    { placeId: "c", area: "Cambridge", cuisines: [{ cuisine: "thai", basis: "primary" }, { cuisine: "bakery", basis: "possibly" }] },
    { placeId: "d", area: "Chinatown", cuisines: [] },
  ];
  const rows = (placeId: string, n: number, included = true) => Array.from({ length: n }, () => ({ placeId, included }));
  it("counts only restaurants with 3 or more included meals, and needs 2 cuisines", () => {
    const p = areaProgress([...rows("a", 3), ...rows("b", 4), ...rows("c", 2), ...rows("d", 5, false)], places);
    expect(p).toEqual([{ area: "Cambridge", restaurants: 3, strongRestaurants: 2, meals: 9, cuisines: 2, meetsMinimum: false }]);
    const q = areaProgress([...rows("a", 3), ...rows("b", 3), ...rows("c", 3)], places);
    expect(q[0]).toMatchObject({ strongRestaurants: 3, cuisines: 2, meetsMinimum: true });
  });
  it("never counts a 'possibly' cuisine", () => {
    const p = areaProgress(rows("c", 3), places);
    expect(p[0].cuisines).toBe(1);
  });
});
