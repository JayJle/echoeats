import { defineTool, ToolError } from "@lovable.dev/mcp-js";
import { z } from "zod";

export default defineTool({
  name: "find_restaurants",
  title: "Find restaurants",
  description:
    "Search real restaurants in a city with Google Maps data (name, address, rating, price level, opening hours, website, sample reviews). Use a short natural-language query such as 'ramen near Shinjuku' or 'brunch with outdoor seating'.",
  inputSchema: {
    city: z.string().describe("City name, e.g. 'Tokyo', '东京', 'St. Louis, MO, USA'."),
    query: z
      .string()
      .describe("What to look for: cuisine, dish, neighborhood or vibe. Keep it short."),
    maxResults: z
      .number()
      .int()
      .describe("How many restaurants to return (1-15). Defaults to 8.")
      .optional(),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  handler: async ({ city, query, maxResults }, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    const cityText = city.trim();
    const queryText = query.trim();
    if (!cityText || !queryText) throw new ToolError("Both `city` and `query` are required.");

    const { searchPlaces, guessLanguageCode, guessRegionCode } = await import(
      "@/lib/google-places.server"
    );

    const limit = Math.min(Math.max(maxResults ?? 8, 1), 15);
    const places = await searchPlaces({
      query: `${queryText} ${cityText}`,
      language: guessLanguageCode(cityText),
      region: guessRegionCode(cityText),
      maxResults: limit,
    });

    const restaurants = places.slice(0, limit).map((p) => ({
      name: p.name,
      address: p.address,
      rating: p.rating,
      reviewCount: p.userRatingCount,
      priceLevel: p.priceLevel,
      openNow: p.openNow,
      primaryType: p.primaryType,
      summary: p.editorialSummary,
      website: p.websiteUri,
      googleMaps: p.googleMapsUri,
      openingHours: p.weekdayDescriptions,
      sampleReviews: p.reviews.slice(0, 3).map((r) => ({
        rating: r.rating,
        text: r.text.slice(0, 400),
      })),
    }));

    if (restaurants.length === 0) {
      return {
        content: [{ type: "text", text: `No restaurants found for "${queryText}" in ${cityText}.` }],
        structuredContent: { city: cityText, query: queryText, restaurants: [] },
      };
    }

    const text = restaurants
      .map((r, i) => {
        const rating = r.rating != null ? `${r.rating}★ (${r.reviewCount ?? 0})` : "no rating";
        return `${i + 1}. ${r.name} — ${rating}${r.priceLevel ? ` · ${r.priceLevel}` : ""}\n   ${r.address}\n   ${r.googleMaps}`;
      })
      .join("\n");

    return {
      content: [{ type: "text", text }],
      structuredContent: { city: cityText, query: queryText, restaurants },
    };
  },
});
