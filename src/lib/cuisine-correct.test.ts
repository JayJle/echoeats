import { describe, expect, it } from "vitest";
import { applyCuisineCorrections, validateCuisineCorrection } from "./cuisine-correct";

describe("validateCuisineCorrection", () => {
  it("accepts typo 团丼 → 豚丼", () => {
    expect(validateCuisineCorrection({ from: "团丼", to: "豚丼", kind: "typo", evidence: "" }, "新宿附近").ok).toBe(true);
  });
  it("accepts refine 寿司 → 回转寿司 with a hard requirement", () => {
    const text = "一定要有回转，要大腹";
    expect(validateCuisineCorrection({ from: "寿司", to: "回转寿司", kind: "refine", evidence: "一定要有回转" }, text).ok).toBe(true);
  });
  it("rejects refine when the requirement is only soft", () => {
    const text = "最好是回转的";
    expect(validateCuisineCorrection({ from: "寿司", to: "回转寿司", kind: "refine", evidence: "最好是回转的" }, text).ok).toBe(false);
  });
  it("rejects switching to another cuisine 寿司 → 海鲜", () => {
    expect(validateCuisineCorrection({ from: "寿司", to: "海鲜", kind: "refine", evidence: "一定要海鲜" }, "一定要海鲜").ok).toBe(false);
    expect(validateCuisineCorrection({ from: "寿司", to: "海鲜", kind: "typo", evidence: "" }, "").ok).toBe(false);
  });
  it("rejects 拉面 → 鱼介拉面 because it is a dish, not a shop format", () => {
    const text = "一定要鱼介拉面";
    expect(validateCuisineCorrection({ from: "拉面", to: "鱼介拉面", kind: "refine", evidence: "一定要鱼介拉面" }, text).ok).toBe(false);
  });
  it("rejects evidence that is not in the user's text", () => {
    expect(validateCuisineCorrection({ from: "寿司", to: "回转寿司", kind: "refine", evidence: "一定要回转" }, "要大腹").ok).toBe(false);
  });
});

describe("applyCuisineCorrections", () => {
  it("keeps the original cuisine when a proposal is rejected", () => {
    const r = applyCuisineCorrections(["拉面"], [{ from: "拉面", to: "鱼介拉面", kind: "refine", evidence: "一定要鱼介拉面" }], "一定要鱼介拉面");
    expect(r.cuisines).toEqual(["拉面"]);
    expect(r.applied).toHaveLength(0);
  });
});
