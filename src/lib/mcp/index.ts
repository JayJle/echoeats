import { auth, defineMcp } from "@lovable.dev/mcp-js";
import findRestaurantsTool from "./tools/find-restaurants";
import suggestCitiesTool from "./tools/suggest-cities";

// The OAuth issuer must be the direct Supabase host; only the project ref
// survives publish unchanged, and Vite inlines this literal at build time.
const projectRef = import.meta.env["VITE_SUPABASE_PROJECT_ID"] ?? "project-ref-unset";

export default defineMcp({
  name: "echo-eats-your-food-concierge",
  title: "Echo Eats: Your Food Concierge",
  version: "0.1.0",
  instructions:
    "Restaurant discovery tools for Echo Eats. Use `suggest_cities` to resolve an ambiguous city name, then `find_restaurants` to get real Google Maps restaurant data (rating, price level, hours, sample reviews) for a city plus a short natural-language query.",
  auth: auth.oauth.issuer({
    issuer: `https://${projectRef}.supabase.co/auth/v1`,
    acceptedAudiences: "authenticated",
  }),
  tools: [suggestCitiesTool, findRestaurantsTool],
});
