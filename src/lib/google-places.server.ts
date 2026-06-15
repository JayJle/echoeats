// Google Places API (New) — Text Search wrapper.
// Docs: https://developers.google.com/maps/documentation/places/web-service/text-search
import { withRetry } from "./retry.server";

export type CityCandidate = {
  placeId: string;
  displayName: string;
  city: string;
  countryOrRegion: string;
};

export async function autocompleteCities(input: string): Promise<CityCandidate[]> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) throw new Error("缺少 GOOGLE_PLACES_API_KEY 环境变量");

  const res = await withRetry(
    (signal) =>
      fetch("https://places.googleapis.com/v1/places:autocomplete", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": [
            "suggestions.placePrediction.placeId",
            "suggestions.placePrediction.text.text",
            "suggestions.placePrediction.structuredFormat.mainText.text",
            "suggestions.placePrediction.structuredFormat.secondaryText.text",
          ].join(","),
        },
        body: JSON.stringify({ input, includedPrimaryTypes: ["(cities)"] }),
        signal,
      }).then(async (response) => {
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Google Places autocomplete ${response.status}: ${text.slice(0, 300)}`);
        }
        return response;
      }),
    { label: "places.city-autocomplete", retries: 1, timeoutMs: 7_000 },
  );

  const json = (await res.json()) as {
    suggestions?: Array<{
      placePrediction?: {
        placeId?: string;
        text?: { text?: string };
        structuredFormat?: {
          mainText?: { text?: string };
          secondaryText?: { text?: string };
        };
      };
    }>;
  };

  const unique = new Map<string, CityCandidate>();
  for (const suggestion of json.suggestions ?? []) {
    const prediction = suggestion.placePrediction;
    const placeId = prediction?.placeId?.trim();
    const city = prediction?.structuredFormat?.mainText?.text?.trim();
    if (!placeId || !city || unique.has(placeId)) continue;
    const countryOrRegion = prediction?.structuredFormat?.secondaryText?.text?.trim() ?? "";
    unique.set(placeId, {
      placeId,
      city,
      countryOrRegion,
      displayName: prediction?.text?.text?.trim() || [city, countryOrRegion].filter(Boolean).join(", "),
    });
    if (unique.size === 5) break;
  }
  return [...unique.values()];
}

export type PlaceCandidate = {
  placeId: string;
  name: string;
  address: string;
  rating: number | null;
  userRatingCount: number | null;
  priceLevel: string | null;
  openNow: boolean | null;
  websiteUri: string | null;
  googleMapsUri: string;
  primaryType: string | null;
  editorialSummary: string | null;
  location: { lat: number; lng: number } | null;
  reviews: { text: string; rating: number | null; authorName: string | null }[];
  photoNames: string[];
  weekdayDescriptions: string[] | null;
  openingPeriods: Array<{
    open: { day: number; hour: number; minute: number };
    close: { day: number; hour: number; minute: number } | null;
  }> | null;
};

const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.rating",
  "places.userRatingCount",
  "places.priceLevel",
  "places.currentOpeningHours.openNow",
  "places.websiteUri",
  "places.googleMapsUri",
  "places.primaryTypeDisplayName",
  "places.editorialSummary",
  "places.location",
  "places.reviews",
  "places.photos",
  "places.regularOpeningHours.weekdayDescriptions",
  "places.regularOpeningHours.periods",
].join(",");

export function guessLanguageCode(city: string): string {
  if (/[\u3040-\u30ff]/.test(city)) return "ja";
  if (/tokyo|kyoto|osaka|nagoya|sapporo|fukuoka|japan|日本|东京|京都|大阪|名古屋|札幌|福冈/i.test(city)) return "ja";
  if (/seoul|busan|korea|首尔|釜山|韩国/i.test(city)) return "ko";
  if (/[\u4e00-\u9fff]/.test(city)) return "zh-CN";
  return "en";
}

export function guessRegionCode(city: string): string | undefined {
  if (/[\u3040-\u30ff]/.test(city)) return "JP";
  if (/japan|日本|tokyo|kyoto|osaka|东京|京都|大阪|sapporo|札幌|yokohama|横滨|横浜|nagoya|名古屋|fukuoka|福冈|福岡|kobe|神户|神戸|nara|奈良|hiroshima|广岛|広島|okinawa|冲绳|沖縄|naha|那霸|那覇|kanazawa|金泽|金沢|sendai|仙台|chiba|千叶|千葉|saitama|埼玉|kawasaki|川崎|hakone|箱根|kamakura|镰仓|鎌倉|nikko|日光|takayama|高山/i.test(city)) return "JP";
  if (/korea|seoul|busan|韩国|首尔/i.test(city)) return "KR";
  // 中国大陆已在第一页拦截，这里不再判 CN
  if (/taiwan|台湾|台北|高雄/i.test(city)) return "TW";
  if (/hong kong|香港/i.test(city)) return "HK";
  if (/singapore|新加坡/i.test(city)) return "SG";
  return undefined;
}

const REGION_ADDRESS_MARKERS: Record<string, RegExp> = {
  JP: /(?:日本|japan|〒)/i,
  HK: /(?:香港|hong\s*kong|hong\s*kong\s*sar)/i,
  MO: /(?:澳门|澳門|macao|macau)/i,
  TW: /(?:台湾|臺灣|taiwan)/i,
  KR: /(?:韩国|韓國|대한민국|south\s*korea|korea)/i,
  CN: /(?:中国|中國|china)/i,
  SG: /(?:新加坡|singapore)/i,
};

function regionFromAddress(address: string): string | null {
  for (const [region, marker] of Object.entries(REGION_ADDRESS_MARKERS)) {
    if (marker.test(address)) return region;
  }
  return null;
}

function locationClearlyOutsideRegion(
  location: PlaceCandidate["location"],
  region: string,
): boolean {
  if (!location) return false;
  const { lat, lng } = location;
  switch (region) {
    case "JP":
      return lat < 23 || lat > 47 || lng < 122 || lng > 146;
    case "HK":
      return lat < 22.1 || lat > 22.7 || lng < 113.8 || lng > 114.5;
    case "SG":
      return lat < 1.1 || lat > 1.6 || lng < 103.5 || lng > 104.2;
    case "KR":
      return lat < 32.8 || lat > 39 || lng < 124 || lng > 132;
    case "TW":
      return lat < 21.5 || lat > 26.5 || lng < 119 || lng > 122.5;
    default:
      return false;
  }
}

function locationClearlyOutsideTargetCity(
  location: PlaceCandidate["location"],
  city: string,
): boolean {
  if (!location) return false;
  const normalizedCity = city.toLowerCase().replace(/\s+/g, "");
  if (!/(?:tokyo|东京|東京|東京都)/i.test(normalizedCity)) return false;
  const { lat, lng } = location;
  // Generous Greater Tokyo bounds: reject clearly remote Japanese results without
  // excluding nearby metro-area restaurants that users reasonably consider Tokyo.
  return lat < 34.9 || lat > 36.2 || lng < 138.8 || lng > 140.6;
}

export function isPlaceClearlyOutsideTargetRegion(
  place: Pick<PlaceCandidate, "address" | "location">,
  targetRegion: string | undefined,
  targetCity = "",
): boolean {
  const region = targetRegion?.toUpperCase();
  if (!region) return false;
  const addressRegion = regionFromAddress(place.address);
  if (addressRegion && addressRegion !== region) return true;
  return (
    locationClearlyOutsideRegion(place.location, region) ||
    locationClearlyOutsideTargetCity(place.location, targetCity)
  );
}

export async function searchPlaces(opts: {
  query: string;
  language: string;
  region?: string;
  maxResults?: number;
}): Promise<PlaceCandidate[]> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) throw new Error("缺少 GOOGLE_PLACES_API_KEY 环境变量");

  const body: Record<string, unknown> = {
    textQuery: opts.query,
    languageCode: opts.language,
    maxResultCount: Math.min(Math.max(opts.maxResults ?? 10, 1), 20),
    includedType: "restaurant",
  };
  if (opts.region) body.regionCode = opts.region;

  const res = await withRetry(
    (signal) =>
      fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": FIELD_MASK,
        },
        body: JSON.stringify(body),
        signal,
      }).then(async (r) => {
        if (!r.ok) {
          const text = await r.text();
          throw new Error(`Google Places ${r.status}: ${text.slice(0, 300)}`);
        }
        return r;
      }),
    { label: `places.search`, retries: 2, timeoutMs: 10_000 },
  );

  const json = (await res.json()) as {
    places?: Array<{
      id: string;
      displayName?: { text?: string };
      formattedAddress?: string;
      rating?: number;
      userRatingCount?: number;
      priceLevel?: string;
      currentOpeningHours?: { openNow?: boolean };
      websiteUri?: string;
      googleMapsUri?: string;
      primaryTypeDisplayName?: { text?: string };
      editorialSummary?: { text?: string };
      location?: { latitude?: number; longitude?: number };
      reviews?: Array<{
        text?: { text?: string } | string;
        originalText?: { text?: string } | string;
        rating?: number;
        authorAttribution?: { displayName?: string };
      }>;
      photos?: Array<{ name?: string }>;
      regularOpeningHours?: {
        weekdayDescriptions?: string[];
        periods?: Array<{
          open?: { day?: number; hour?: number; minute?: number };
          close?: { day?: number; hour?: number; minute?: number };
        }>;
      };
    }>;
  };

  return (json.places ?? []).map((p) => ({
    placeId: p.id,
    name: p.displayName?.text ?? "",
    address: p.formattedAddress ?? "",
    rating: p.rating ?? null,
    userRatingCount: p.userRatingCount ?? null,
    priceLevel: p.priceLevel ?? null,
    openNow: p.currentOpeningHours?.openNow ?? null,
    websiteUri: p.websiteUri ?? null,
    googleMapsUri:
      p.googleMapsUri ?? `https://www.google.com/maps/place/?q=place_id:${p.id}`,
    primaryType: p.primaryTypeDisplayName?.text ?? null,
    editorialSummary: p.editorialSummary?.text ?? null,
    location: p.location?.latitude != null && p.location.longitude != null
      ? { lat: p.location.latitude, lng: p.location.longitude }
      : null,
    reviews: (p.reviews ?? [])
      .map((r) => {
        const t =
          (typeof r.text === "object" ? r.text?.text : r.text) ??
          (typeof r.originalText === "object" ? r.originalText?.text : r.originalText) ??
          "";
        return {
          text: typeof t === "string" ? t.trim() : "",
          rating: typeof r.rating === "number" ? r.rating : null,
          authorName: r.authorAttribution?.displayName ?? null,
        };
      })
      .filter((r) => r.text.length >= 5)
      .slice(0, 5),
    photoNames: (p.photos ?? [])
      .map((ph) => ph.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0)
      .slice(0, 3),
    weekdayDescriptions: p.regularOpeningHours?.weekdayDescriptions ?? null,
    openingPeriods: (() => {
      const periods = p.regularOpeningHours?.periods;
      if (!Array.isArray(periods) || periods.length === 0) return null;
      const out = periods
        .map((pd) => {
          const o = pd.open;
          if (!o || typeof o.day !== "number" || typeof o.hour !== "number") return null;
          const open = { day: o.day, hour: o.hour, minute: o.minute ?? 0 };
          const c = pd.close;
          const close =
            c && typeof c.day === "number" && typeof c.hour === "number"
              ? { day: c.day, hour: c.hour, minute: c.minute ?? 0 }
              : null;
          return { open, close };
        })
        .filter((x): x is NonNullable<typeof x> => Boolean(x));
      return out.length ? out : null;
    })(),
  })).filter((p) => p.placeId && p.name);
}

// Resolves a Google Places photo `name` to a publicly fetchable image URL.
// Uses skipHttpRedirect to get the actual googleusercontent URL (cacheable, no API key needed by client).
const photoUrlCache = new Map<string, string | null>();

export async function resolvePhotoUrl(
  photoName: string,
  maxWidthPx = 800,
): Promise<string | null> {
  const cacheKey = `${photoName}|${maxWidthPx}`;
  if (photoUrlCache.has(cacheKey)) return photoUrlCache.get(cacheKey)!;

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return null;

  try {
    const url = `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=${maxWidthPx}&skipHttpRedirect=true&key=${apiKey}`;
    const res = await withRetry(
      (signal) =>
        fetch(url, { signal }).then(async (r) => {
          if (!r.ok) throw new Error(`Places photo ${r.status}`);
          return r;
        }),
      { label: "places.photo", retries: 1, timeoutMs: 6_000 },
    );
    const json = (await res.json()) as { photoUri?: string };
    const photoUri = json.photoUri ?? null;
    // 关键修复：只在成功（拿到 URL）时写缓存，避免毒化后续刷新。
    if (photoUri) photoUrlCache.set(cacheKey, photoUri);
    return photoUri;
  } catch (e) {
    console.warn(`[places.photo] fail`, e instanceof Error ? e.message : e);
    return null;
  }
}

