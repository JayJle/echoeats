import { describe, expect, it } from "vitest";
import { parseReviews, officialDomain, PLATFORM_REVIEW_LIMIT } from "./evidence.server";

describe("platform reviews", () => {
  it("keeps at most 6 raw reviews", () => {
    const raw = Array.from({ length: 10 }, (_, i) => ({ text: `review text number ${i}`, rating: 4, date: null }));
    expect(PLATFORM_REVIEW_LIMIT).toBe(6);
    expect(parseReviews(raw)).toHaveLength(6);
  });
});

describe("official site", () => {
  it("treats social and booking links as no official site", () => {
    expect(officialDomain("https://www.instagram.com/foo")).toBeNull();
    expect(officialDomain("https://www.opentable.com/r/foo")).toBeNull();
    expect(officialDomain("https://www.sushi-ginza.jp/menu")).toBe("sushi-ginza.jp");
  });
});
