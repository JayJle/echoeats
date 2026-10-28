import { describe, it, expect } from "vitest";
import { clampWeight, finalizeEdited } from "./weights";

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
