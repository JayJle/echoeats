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
  stage: string;
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

export type ChatMsg = {
  role: "ai" | "user";
  text: string;
  field?: string;
};

type QueryState = {
  // 保留 city / freeText / cuisines 以兼容 parseRequirements 与 results 编辑弹窗
  city: string;
  cuisines: string[];
  autoInferCuisines: boolean;
  date: string;
  freeText: string;
  // 新增：chat 状态
  chatHistory: ChatMsg[];
  askedFields: string[];
  skippedFields: string[];
  parsed: ParsedRequirements | null;
  results: SearchResults | null;
  setCity: (v: string) => void;
  setCuisines: (v: string[]) => void;
  setAutoInferCuisines: (v: boolean) => void;
  setDate: (v: string) => void;
  setFreeText: (v: string) => void;
  setChatHistory: (v: ChatMsg[]) => void;
  setAskedFields: (v: string[]) => void;
  setSkippedFields: (v: string[]) => void;
  setParsed: (v: ParsedRequirements | null) => void;
  setResults: (v: SearchResults | null) => void;
  resetChat: () => void;
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
      chatHistory: [],
      askedFields: [],
      skippedFields: [],
      parsed: null,
      results: null,
      setCity: (v) => set({ city: v }),
      setCuisines: (v) => set({ cuisines: v }),
      setAutoInferCuisines: (v) => set({ autoInferCuisines: v }),
      setDate: (v) => set({ date: v }),
      setFreeText: (v) => set({ freeText: v }),
      setChatHistory: (v) => set({ chatHistory: v }),
      setAskedFields: (v) => set({ askedFields: v }),
      setSkippedFields: (v) => set({ skippedFields: v }),
      setParsed: (v) => set({ parsed: v }),
      setResults: (v) => set({ results: v }),
      resetChat: () =>
        set({
          chatHistory: [],
          askedFields: [],
          skippedFields: [],
          freeText: "",
          parsed: null,
          results: null,
        }),
      reset: () =>
        set({
          city: "",
          cuisines: [],
          autoInferCuisines: true,
          date: "",
          freeText: "",
          chatHistory: [],
          askedFields: [],
          skippedFields: [],
          parsed: null,
          results: null,
        }),
    }),

    {
      name: "echo-eats-query",
      version: 3,
      migrate: (persisted: unknown, version: number) => {
        const state = persisted as
          | (Partial<QueryState> & { parsed?: ParsedRequirements | null })
          | undefined;
        if (!state) return state as QueryState;
        if (version < 2 && state.parsed) {
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
        if (version < 3) {
          state.chatHistory = state.chatHistory ?? [];
          state.askedFields = state.askedFields ?? [];
          state.skippedFields = state.skippedFields ?? [];
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
