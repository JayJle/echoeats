import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export type ParsedRequirements = {
  city: string;
  cuisines: string[];
  dateTime: string;
  hardFilters: string[];
  softPreferences: string[];
  negativeFilters: string[];
  dishPreferences: string[];
  searchStrategy: string[];
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
  photoUrl: string | null;
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
      storage: createJSONStorage(() =>
        typeof window !== "undefined" ? sessionStorage : (undefined as unknown as Storage),
      ),
    },
  ),
);
