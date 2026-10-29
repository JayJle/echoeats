import { describe, it, expect } from "vitest";
import { clampWeight, finalizeEdited, foldDishes } from "./weights";

const base = {
  city: "Tokyo", cuisines: [], dateTime: "", dishPreferences: [], searchStrategy: [],
  hardFilters: [], softPreferences: [], negativeFilters: [],
};

describe("weights", () => {
  it("clamps weight to 0.1–1.0", () => {
    expect(clampWeight(0)).toBe(0.1);
    expect(clampWeight(1.4)).toBe(1);
    expect(clampWeight(0.66)).toBe(0.7);
  });
  it("nice-to-have at 0.8 becomes must-have", () => {
    const r = finalizeEdited({ ...base, softPreferences: [{ text: "quiet", weight: 0.8 }, { text: "view", weight: 0.5 }] });
    expect(r.hardFilters.map((h) => h.text)).toEqual(["quiet"]);
    expect(r.softPreferences.map((h) => h.text)).toEqual(["view"]);
  });
});

describe("dishes folded into preferences", () => {
  it("adds an untagged dish as a nice-to-have at 0.6", () => {
    const r = foldDishes({ ...base, dishPreferences: ["拉面"] });
    expect(r.softPreferences).toEqual([{ text: "拉面", weight: 0.6, dish: "拉面" }]);
    expect(r.dishPreferences).toEqual(["拉面"]);
  });
  it("tags a matching must-have instead of duplicating it", () => {
    const r = foldDishes({ ...base, hardFilters: [{ text: "必须有蟹刺身", weight: 1 }], dishPreferences: ["蟹刺身"] });
    expect(r.hardFilters).toEqual([{ text: "必须有蟹刺身", weight: 1, dish: "蟹刺身" }]);
    expect(r.softPreferences).toEqual([]);
  });
  it("never tags an avoid item", () => {
    const r = foldDishes({ ...base, negativeFilters: [{ text: "不要生鱼片", weight: 0.7 }], dishPreferences: ["生鱼片"] });
    expect(r.negativeFilters[0].dish).toBeUndefined();
    expect(r.softPreferences[0].dish).toBe("生鱼片");
  });
  it("removing a dish row in the editor removes the dish", () => {
    const r = finalizeEdited({ ...base, softPreferences: [{ text: "安静", weight: 0.5 }], dishPreferences: ["拉面"] });
    expect(r.dishPreferences).toEqual([]);
  });
});
