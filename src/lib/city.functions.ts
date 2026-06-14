import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const CityInput = z.object({
  city: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[\p{L}\p{M}\p{N}\s,.'’()\-·]+$/u),
});

export type CityValidationCandidate = {
  placeId: string;
  displayName: string;
  city: string;
  countryOrRegion: string;
};

export type CityValidationResult =
  | { status: "confirmed"; candidate: CityValidationCandidate }
  | { status: "choose"; candidates: CityValidationCandidate[] }
  | { status: "not_found" }
  | { status: "invalid" }
  | { status: "unavailable" };

function normalizeCity(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s,.'’()\-·]+/gu, "");
}

export const validateCity = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => {
    const parsed = CityInput.safeParse(input);
    return parsed.success ? parsed.data : null;
  })
  .handler(async ({ data }): Promise<CityValidationResult> => {
    if (!data) return { status: "invalid" };
    try {
      const { autocompleteCities } = await import("./google-places.server");
      const candidates = await autocompleteCities(data.city);
      if (candidates.length === 0) return { status: "not_found" };

      const normalizedInput = normalizeCity(data.city);
      const exactCandidates = candidates.filter(
        (candidate) => normalizeCity(candidate.city) === normalizedInput,
      );
      if (exactCandidates.length === 1) {
        return { status: "confirmed", candidate: exactCandidates[0] };
      }
      return { status: "choose", candidates };
    } catch (error) {
      console.warn(
        "[city.validation] unavailable",
        error instanceof Error ? error.message : String(error),
      );
      return { status: "unavailable" };
    }
  });