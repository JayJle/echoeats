import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export type WeightedCondition = {
  text: string;
  weight: number; // 0.1 - 1.0
};

export type ParsedRequirements = {
  city: string;
  cuisines: string[];
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
  ratings: { platform: string; score: string | null }[];
  aiSummary: string;
  matchDetails: { label: string; status: "ok" | "warn" }[];
  pros: string[];
  cons: string[];
  links: { label: string; url: string }[];
  photoUrls: string[];
  tabelog: {
    rating: string | null;
    reviewCount: number | null;
    url: string | null;
    priceRange: string | null;
    summary: string | null;
  } | null;
  weekdayDescriptions?: string[] | null;
  visitTimeMatch?: "open" | "unknown" | null;
};

export type ResultsGroup = { cuisine: string; restaurants: Restaurant[]; partialRestaurants?: Restaurant[] };

export type SearchResults = {
  groups: ResultsGroup[];
  error: string | null;
  suggestions: string[];
};

type QueryState = {
  city: string;
  cuisines: string[];
  date: string;
  freeText: string;
  parsed: ParsedRequirements | null;
  results: SearchResults | null;
  setCity: (v: string) => void;
  setCuisines: (v: string[]) => void;
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
      date: "",
      freeText: "",
      parsed: null,
      results: null,
      setCity: (v) => set({ city: v }),
      setCuisines: (v) => set({ cuisines: v }),
      setDate: (v) => set({ date: v }),
      setFreeText: (v) => set({ freeText: v }),
      setParsed: (v) => set({ parsed: v }),
      setResults: (v) => set({ results: v }),
      reset: () =>
        set({
          city: "",
          cuisines: [],
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
