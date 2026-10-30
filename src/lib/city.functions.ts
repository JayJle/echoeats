import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { isMainlandChinaCity, isMainlandChinaRegion } from "./region.server";

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
  | { status: "choose"; candidates: CityValidationCandidate[]; notCity?: boolean }
  | { status: "not_found" }
  | { status: "invalid" }
  | { status: "unsupported_region" }
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
    // 入口拦截：明显的中国大陆输入直接拒绝（港澳台不受影响）。
    if (isMainlandChinaCity(data.city)) {
      return { status: "unsupported_region" };
    }
    try {
      const { autocompleteCities } = await import("./google-places.server");
      const candidates = await autocompleteCities(data.city);
      if (candidates.length === 0) return { status: "not_found" };

      // 过滤候选：剔除中国大陆地点（保留港澳台）。
      const filtered = candidates.filter(
        (c) => !isMainlandChinaRegion(c.countryOrRegion) && !isMainlandChinaCity(c.city),
      );
      if (filtered.length === 0) return { status: "unsupported_region" };

      // 永不自动确认：用户必须亲自从候选中选择。
      // 若输入与某候选的国家/地区同名（如“日本”），提示这不是城市。
      const normalizedInput = normalizeCity(data.city);
      const notCity = filtered.some(
        (c) => c.countryOrRegion && normalizeCity(c.countryOrRegion) === normalizedInput,
      ) || !filtered.some((c) => normalizeCity(c.city) === normalizedInput);
      return { status: "choose", candidates: filtered, notCity };
    } catch (error) {
      console.warn(
        "[city.validation] unavailable",
        error instanceof Error ? error.message : String(error),
      );
      return { status: "unavailable" };
    }
  });