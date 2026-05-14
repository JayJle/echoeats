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
  matchScore: number;
  matchTier: "perfect" | "high" | "partial";
  openNow: boolean;
  reservable: boolean;
  ratings: { platform: string; score: string | null }[];
  aiSummary: string;
  matchDetails: { label: string; status: "ok" | "warn" }[];
  pros: string[];
  cons: string[];
  links: { label: string; url: string }[];
};

export type ResultsGroup = { cuisine: string; restaurants: Restaurant[] };

type QueryState = {
  city: string;
  cuisines: string[];
  date: string;
  time: string;
  freeText: string;
  parsed: ParsedRequirements | null;
  results: ResultsGroup[] | null;
  setCity: (v: string) => void;
  setCuisines: (v: string[]) => void;
  setDate: (v: string) => void;
  setTime: (v: string) => void;
  setFreeText: (v: string) => void;
  setParsed: (v: ParsedRequirements | null) => void;
  setResults: (v: ResultsGroup[] | null) => void;
  reset: () => void;
};

export const useQueryStore = create<QueryState>()(
  persist(
    (set) => ({
      city: "",
      cuisines: [],
      date: "",
      time: "",
      freeText: "",
      parsed: null,
      results: null,
      setCity: (v) => set({ city: v }),
      setCuisines: (v) => set({ cuisines: v }),
      setDate: (v) => set({ date: v }),
      setTime: (v) => set({ time: v }),
      setFreeText: (v) => set({ freeText: v }),
      setParsed: (v) => set({ parsed: v }),
      setResults: (v) => set({ results: v }),
      reset: () =>
        set({
          city: "",
          cuisines: [],
          date: "",
          time: "",
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
