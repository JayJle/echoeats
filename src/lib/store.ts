import { useEffect, useState } from "react";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export type WeightedCondition = {
  text: string;
  weight: number; // 0.1 - 1.0
};

export type ParsedRequirements = {
  city: string;
  cuisines: string[];
  cuisinesInferred?: boolean;
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
  matchDetails: { label: string; status: "ok" | "warn" }[];
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
  weekdayDescriptions?: string[] | null;
  visitTimeMatch?: "open" | "unknown" | null;
};

export type ResultsGroup = {
  cuisine: string;
  restaurants: Restaurant[];
  okRestaurants?: Restaurant[];
  partialRestaurants?: Restaurant[];
  failedRestaurants?: Restaurant[];
};

export type SearchWarning = {
  stage: string;          // "places" | "tabelog" | "yelp" | "dianping" | "cuisine-expand" | "photos" | "ai-rank"
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

type QueryState = {
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
      storage: createJSONStorage(() =>
        typeof window !== "undefined" ? sessionStorage : (undefined as unknown as Storage),
      ),
    },
  ),
);

export function useStoreHydrated(): boolean {
  const [hydrated, setHydrated] = useState(() => useQueryStore.persist.hasHydrated());
  useEffect(() => {
    const unsubFinish = useQueryStore.persist.onFinishHydration(() => setHydrated(true));
    const unsubHydrate = useQueryStore.persist.onHydrate(() => setHydrated(false));
    setHydrated(useQueryStore.persist.hasHydrated());
    return () => {
      unsubFinish();
      unsubHydrate();
    };
  }, []);
  return hydrated;
}
