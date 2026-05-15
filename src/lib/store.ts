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
  photoUrls: string[];
  tabelog: {
    rating: string | null;
    reviewCount: number | null;
    url: string | null;
    priceRange: string | null;
    summary: string | null;
  } | null;
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
  _hasHydrated: boolean;
  setCity: (v: string) => void;
  setCuisines: (v: string[]) => void;
  setDate: (v: string) => void;
  setFreeText: (v: string) => void;
  setParsed: (v: ParsedRequirements | null) => void;
  setResults: (v: SearchResults | null) => void;
  setHasHydrated: (v: boolean) => void;
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
      _hasHydrated: false,
      setCity: (v) => set({ city: v }),
      setCuisines: (v) => set({ cuisines: v }),
      setDate: (v) => set({ date: v }),
      setFreeText: (v) => set({ freeText: v }),
      setParsed: (v) => set({ parsed: v }),
      setResults: (v) => set({ results: v }),
      setHasHydrated: (v) => set({ _hasHydrated: v }),
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
      partialize: (state) => ({
        city: state.city,
        cuisines: state.cuisines,
        date: state.date,
        freeText: state.freeText,
        parsed: state.parsed,
        results: state.results,
      }),
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    },
  ),
);
