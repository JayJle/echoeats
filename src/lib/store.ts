import { useEffect, useState } from "react";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export type WeightedCondition = {
  text: string;
  weight: number; // 0.1 - 1.0
  dish?: string; // set when this condition is a dish the user wants
};

export type ParsedRequirements = {
  city: string;
  cuisines: string[];
  cuisinesInferred?: boolean;
  cuisineCorrections?: { from: string; to: string; kind: "typo" | "refine" | "expand"; evidence: string }[];
  cuisineLevelConstraints?: WeightedCondition[];
  dateTime: string;
  hardFilters: WeightedCondition[];
  softPreferences: WeightedCondition[];
  negativeFilters: WeightedCondition[];
  dishPreferences: string[];
  searchStrategy: string[];
  visitTime?: {
    mentioned: boolean;
    evidence: string;
    weekday: number | null;
    hhmm: string | null;
    raw: string;
  } | null;
};

export type Restaurant = {
  id: string;
  name: string;
  localName: string;
  cuisine: string;
  address: string;
  googleMapsUri: string;
  websiteUri: string | null;
  primaryType: string | null;
  matchScore: number;
  matchTier: "perfect" | "high" | "partial";
  openNow: boolean;
  reservable: boolean;
  needsReview: boolean;
  verificationStatus?: "ok" | "unknown" | "fail";
  ratings: { platform: string; score: string | null }[];
  aiSummary: string;
  matchDetails: { label: string; status: "ok" | "unknown" | "fail" }[];
  pros: { text: string; source?: string | null }[];
  cons: { text: string; source?: string | null }[];
  links: { label: string; url: string }[];
  photoUrls: string[];
  tabelog: {
    rating: string | null;
    reviewCount: number | null;
    url: string | null;
    priceRange: string | null;
    summary: string | null;
  } | null;
  yelp?: {
    rating: string | null;
    reviewCount: number | null;
    url: string | null;
    priceLevel: string | null;
    summary: string | null;
    confidence?: "high" | "medium" | "low";
  } | null;
  officialSite?: {
    url: string;
    signatureDishes: string[];
    menu: { name: string; price: string | null }[];
  } | null;
  weekdayDescriptions?: string[] | null;
  visitTimeMatch?: "open" | "unknown" | null;
  scoreBreakdown?: { label: string; delta: number }[];
  recallSources?: string[];
};

export type ResultsGroup = {
  cuisine: string;
  restaurants: Restaurant[];
  okRestaurants?: Restaurant[];
  partialRestaurants?: Restaurant[];
  failedRestaurants?: Restaurant[];
};

export type SearchWarning = {
  stage: string;          // "places" | "tabelog" | "yelp" | "cuisine-expand" | "photos" | "ai-rank"
  cuisine?: string;
  message: string;
  retryable?: boolean;
};

export type SearchResults = {
  groups: ResultsGroup[];
  error: string | null;
  suggestions: string[];
  warnings?: SearchWarning[];
};

export type SearchSnapshot = { parsed: ParsedRequirements; results: SearchResults; freeText: string };
export type ResearchJob = {
  parsed: ParsedRequirements;
  freeText: string;
  language: "zh" | "en";
  reparse?: boolean;
  autoInferCuisines?: boolean;
};

type QueryState = {
  researchJob: ResearchJob | null;
  pendingResults: SearchSnapshot | null;
  researchError: string | null;
  startResearch: (job: ResearchJob) => void;
  finishResearch: (job: ResearchJob, snapshot: SearchSnapshot) => void;
  failResearch: (job: ResearchJob, error: string) => void;
  cancelResearch: () => void;
  viewPendingResults: () => void;
  city: string;
  cuisines: string[];
  autoInferCuisines: boolean;
  date: string;
  freeText: string;
  parsed: ParsedRequirements | null;
  results: SearchResults | null;
  setCity: (v: string) => void;
  setCuisines: (v: string[]) => void;
  setAutoInferCuisines: (v: boolean) => void;
  setDate: (v: string) => void;
  setFreeText: (v: string) => void;
  setParsed: (v: ParsedRequirements | null) => void;
  setResults: (v: SearchResults | null) => void;
  reset: () => void;
};

export const useQueryStore = create<QueryState>()(
  persist(
    (set) => ({
      researchJob: null,
      pendingResults: null,
      researchError: null,
      startResearch: (job) => set({ researchJob: job, researchError: null }),
      finishResearch: (job, snapshot) => set((s) => s.researchJob === job
        ? { researchJob: null, pendingResults: snapshot, researchError: null } : {}),
      failResearch: (job, error) => set((s) => s.researchJob === job
        ? { researchJob: null, researchError: error } : {}),
      cancelResearch: () => set({ researchJob: null, researchError: null }),
      viewPendingResults: () => set((s) => s.pendingResults
        ? { ...s.pendingResults, pendingResults: null, researchError: null } : {}),
      city: "",
      cuisines: [],
      autoInferCuisines: true,
      date: "",
      freeText: "",
      parsed: null,
      results: null,
      setCity: (v) => set({ city: v }),
      setCuisines: (v) => set({ cuisines: v }),
      setAutoInferCuisines: (v) => set({ autoInferCuisines: v }),
      setDate: (v) => set({ date: v }),
      setFreeText: (v) => set({ freeText: v }),
      setParsed: (v) => set({ parsed: v }),
      setResults: (v) => set({ results: v }),
      reset: () =>
        set({
          researchJob: null,
          pendingResults: null,
          researchError: null,
          city: "",
          cuisines: [],
          autoInferCuisines: true,
          date: "",
          freeText: "",
          parsed: null,
          results: null,
        }),
    }),

    {
      name: "echo-eats-query",
      version: 2,
      partialize: ({ researchJob: _job, researchError: _error, ...state }) => state,
      migrate: (persisted: unknown, version: number) => {
        const state = persisted as { parsed?: ParsedRequirements | null } | undefined;
        if (version < 2 && state?.parsed) {
          const upgrade = (arr: unknown): WeightedCondition[] => {
            if (!Array.isArray(arr)) return [];
            return arr.map((item) =>
              typeof item === "string"
                ? { text: item, weight: 0.8 }
                : (item as WeightedCondition),
            );
          };
          const p = state.parsed as unknown as Record<string, unknown>;
          state.parsed = {
            ...(state.parsed as ParsedRequirements),
            hardFilters: upgrade(p.hardFilters),
            softPreferences: upgrade(p.softPreferences),
            negativeFilters: upgrade(p.negativeFilters),
          };
        }
        return state as QueryState;
      },
      storage: createJSONStorage(() => {
        if (typeof window === "undefined") throw new Error("Session storage is browser-only");
        return sessionStorage;
      }),
    },
  ),
);

export function useStoreHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    const persistence = useQueryStore.persist;
    if (!persistence) { setHydrated(true); return; }
    const unsubFinish = persistence.onFinishHydration(() => setHydrated(true));
    const unsubHydrate = persistence.onHydrate(() => setHydrated(false));
    setHydrated(persistence.hasHydrated());
    return () => {
      unsubFinish();
      unsubHydrate();
    };
  }, []);
  return hydrated;
}
