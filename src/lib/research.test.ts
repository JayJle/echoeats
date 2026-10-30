import { beforeEach, describe, expect, it } from "vitest";
import { useQueryStore, type ParsedRequirements, type ResearchJob, type SearchSnapshot } from "./store";

const parsed: ParsedRequirements = { city: "Tokyo", cuisines: ["Sushi"], dateTime: "", hardFilters: [], softPreferences: [], negativeFilters: [], dishPreferences: [], searchStrategy: [] };
const oldResults = { groups: [{ cuisine: "Sushi", restaurants: [] }], error: null, suggestions: [] };
const next: SearchSnapshot = { parsed: { ...parsed, cuisines: ["Ramen"] }, freeText: "ramen", results: { groups: [{ cuisine: "Ramen", restaurants: [] }], error: null, suggestions: [] } };
const job: ResearchJob = { parsed: next.parsed, freeText: next.freeText, language: "zh" };
beforeEach(() => {
  useQueryStore.getState().reset();
  useQueryStore.setState({ parsed, results: oldResults, freeText: "sushi" });
});
describe("re-search snapshots", () => {
  it("keeps old results and conditions while searching and after full completion until explicit viewing", () => {
    useQueryStore.getState().startResearch(job);
    expect(useQueryStore.getState().results).toEqual(oldResults);
    useQueryStore.getState().finishResearch(job, next);
    expect(useQueryStore.getState().results).toEqual(oldResults);
    expect(useQueryStore.getState().parsed).toEqual(parsed);
    expect(useQueryStore.getState().freeText).toBe("sushi");
    expect(useQueryStore.getState().pendingResults).toEqual(next);
  });
  it("switches results and corresponding conditions atomically when requested", () => {
    useQueryStore.getState().startResearch(job);
    useQueryStore.getState().finishResearch(job, next);
    useQueryStore.getState().viewPendingResults();
    expect(useQueryStore.getState().results).toEqual(next.results);
    expect(useQueryStore.getState().parsed).toEqual(next.parsed);
    expect(useQueryStore.getState().freeText).toBe("ramen");
    expect(useQueryStore.getState().pendingResults).toBeNull();
  });
  it("cancellation or failure never replaces old results", () => {
    useQueryStore.getState().startResearch(job);
    useQueryStore.getState().cancelResearch();
    useQueryStore.getState().finishResearch(job, next);
    expect(useQueryStore.getState().pendingResults).toBeNull();
    useQueryStore.getState().startResearch(job);
    useQueryStore.getState().failResearch(job, "failed");
    expect(useQueryStore.getState().results).toEqual(oldResults);
  });
  it("rejects a late completion from a superseded search", () => {
    useQueryStore.getState().startResearch(job);
    useQueryStore.getState().startResearch({ ...job });
    useQueryStore.getState().finishResearch(job, next);
    expect(useQueryStore.getState().pendingResults).toBeNull();
  });
});