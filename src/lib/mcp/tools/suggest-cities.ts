import { defineTool, ToolError } from "@lovable.dev/mcp-js";
import { z } from "zod";

export default defineTool({
  name: "suggest_cities",
  title: "Suggest cities",
  description:
    "Resolve a partial or ambiguous city name into real city candidates (formatted name, country) before calling find_restaurants.",
  inputSchema: {
    input: z.string().describe("Partial city name typed by the user, e.g. 'toky', '新宿'."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  handler: async ({ input }, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    const text = input.trim();
    if (!text) throw new ToolError("`input` must not be empty.");

    const { autocompleteCities } = await import("@/lib/google-places.server");
    const cities = await autocompleteCities(text);

    return {
      content: [
        {
          type: "text",
          text:
            cities.length === 0
              ? `No city matched "${text}".`
              : cities.map((c, i) => `${i + 1}. ${JSON.stringify(c)}`).join("\n"),
        },
      ],
      structuredContent: { cities },
    };
  },
});
