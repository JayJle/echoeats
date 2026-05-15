// Google Places API (New) — Text Search wrapper.
// Docs: https://developers.google.com/maps/documentation/places/web-service/text-search

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
].join(",");

export function guessLanguageCode(city: string): string {
  if (/[\u3040-\u30ff]/.test(city)) return "ja";
  if (/tokyo|kyoto|osaka|nagoya|sapporo|fukuoka|japan|日本|东京|京都|大阪|名古屋|札幌|福冈/i.test(city)) return "ja";
  if (/seoul|busan|korea|首尔|釜山|韩国/i.test(city)) return "ko";
  if (/[\u4e00-\u9fff]/.test(city)) return "zh-CN";
  return "en";
}

export function guessRegionCode(city: string): string | undefined {
  if (/japan|日本|tokyo|kyoto|osaka|东京|京都|大阪/i.test(city)) return "JP";
  if (/korea|seoul|busan|韩国|首尔/i.test(city)) return "KR";
  if (/china|中国|北京|上海|广州|深圳|成都|杭州|武汉|南京|重庆/i.test(city)) return "CN";
  if (/taiwan|台湾|台北|高雄/i.test(city)) return "TW";
  if (/hong kong|香港/i.test(city)) return "HK";
  if (/singapore|新加坡/i.test(city)) return "SG";
  return undefined;
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

  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": FIELD_MASK,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google Places ${res.status}: ${text.slice(0, 300)}`);
  }

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
  })).filter((p) => p.placeId && p.name);
}
