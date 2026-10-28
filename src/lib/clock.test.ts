import { describe, it, expect } from "vitest";
import { inferExplicitClock } from "./echo.functions";
describe("inferExplicitClock", () => {
  it("reads 6:30 PM as 18:30", () => expect(inferExplicitClock("dinner around 6:30 PM")).toBe("18:30"));
  it("reads 7pm as 19:00", () => expect(inferExplicitClock("at 7pm")).toBe("19:00"));
  it("keeps 24h 18:30", () => expect(inferExplicitClock("18:30 dinner")).toBe("18:30"));
  it("reads 12 AM as 00:00", () => expect(inferExplicitClock("12:00 AM")).toBe("00:00"));
});
