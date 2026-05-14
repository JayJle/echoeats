import { createServerFn } from "@tanstack/react-start";
import { generateText, Output } from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "./ai-gateway";

const ParseInput = z.object({
  city: z.string().min(1),
  cuisines: z.array(z.string()).min(1),
  date: z.string().min(1),
  time: z.string().min(1),
  freeText: z.string().default(""),
});

const ParsedSchema = z.object({
  city: z.string(),
  cuisines: z.array(z.string()),
  dateTime: z.string(),
  hardFilters: z.array(z.string()),
  softPreferences: z.array(z.string()),
  negativeFilters: z.array(z.string()),
  dishPreferences: z.array(z.string()),
  searchStrategy: z.array(z.string()),
});

export const parseRequirements = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => ParseInput.parse(input))
  .handler(async ({ data }) => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("Missing LOVABLE_API_KEY");
    const gateway = createLovableAiGatewayProvider(key);
    const model = gateway("google/gemini-3-flash-preview");

    const prompt = `你是 Echo Eats 的需求结构化引擎。用户填写了餐厅搜索表单：

- 城市：${data.city}
- 料理类型：${data.cuisines.join("、")}
- 日期：${data.date}
- 时间：${data.time}
- 其它需求（自然语言）：${data.freeText || "（无）"}

请把需求结构化为 JSON。规则：
- hardFilters：必须满足的硬条件（包含城市、料理、营业时间、明确预算、可预约等）。每条简短中文。
- softPreferences：偏好（氛围、评分、适合场景等）。
- negativeFilters：避雷条件（不要游客店、避免吵闹等）。
- dishPreferences：希望吃到的具体菜品。
- searchStrategy：3-5 条搜索策略说明，比如"优先本地高分""排除连锁游客店"等。
- dateTime：合并为可读字符串，如 "2026/05/20 19:30"。
- city/cuisines：原样回传。

如果用户没提到某类，返回空数组。所有内容用简体中文。`;

    try {
      const { experimental_output } = await generateText({
        model,
        prompt,
        maxOutputTokens: 2000,
        experimental_output: Output.object({ schema: ParsedSchema }),
      });
      return experimental_output;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`AI 解析失败：${msg}`);
    }
  });

const RestaurantSchema = z.object({
  id: z.string(),
  name: z.string(),
  localName: z.string(),
  cuisine: z.string(),
  matchScore: z.number().min(0).max(100),
  matchTier: z.enum(["perfect", "high", "partial"]),
  openNow: z.boolean(),
  reservable: z.boolean(),
  ratings: z.array(z.object({ platform: z.string(), score: z.string().nullable() })),
  aiSummary: z.string(),
  matchDetails: z.array(z.object({ label: z.string(), status: z.enum(["ok", "warn"]) })),
  pros: z.array(z.string()),
  cons: z.array(z.string()),
  links: z.array(z.object({ label: z.string(), url: z.string() })),
});

const ResultsSchema = z.object({
  groups: z.array(
    z.object({
      cuisine: z.string(),
      restaurants: z.array(RestaurantSchema),
    }),
  ),
});

export const searchRestaurants = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => ParsedSchema.parse(input))
  .handler(async ({ data }) => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("Missing LOVABLE_API_KEY");
    const gateway = createLovableAiGatewayProvider(key);
    const model = gateway("google/gemini-3-flash-preview");

    const prompt = `你是 Echo Eats 的餐厅推荐引擎。基于以下结构化需求，给出最匹配的真实餐厅候选清单。

城市：${data.city}
料理：${data.cuisines.join("、")}
日期/时间：${data.dateTime}
硬条件：${data.hardFilters.join("；") || "无"}
偏好：${data.softPreferences.join("；") || "无"}
避雷：${data.negativeFilters.join("；") || "无"}
菜品偏好：${data.dishPreferences.join("；") || "无"}
搜索策略：${data.searchStrategy.join("；") || "无"}

要求：
- 按"料理类型"分组（每个用户输入的料理类型一组）。
- 每组返回 1-3 家真实存在或合理虚构的当地知名餐厅候选，按 matchScore 降序。
- name 用英文/罗马字，localName 用本地语言（日本=日文，中国=中文）。
- matchScore 0-100。matchTier：>=92 perfect, >=80 high, 其余 partial。
- ratings 包含 Google Maps / Tabelog / Yelp / 大众点评 / 美团 五项；不存在的平台 score 设为 null。日本店通常无大众点评/美团数据，中国店通常无 Tabelog。分数为字符串如 "4.5 / 5" 或 "3.68 / 5"。
- aiSummary 用一段中文解释推荐理由（2-3 句），结合用户的偏好与避雷。
- matchDetails 列出 5-7 条匹配点，status=ok 表示符合，warn 表示提醒（如"晚餐需提前预约"）。
- pros / cons 各 2-4 条简短中文。
- links 包含相关平台搜索链接（用 https://www.google.com/maps/search/?api=1&query=... 这类可点击 URL，至少 2 条）。
- id 用短小写英文 slug。
- openNow / reservable 设为合理值（多数为 true）。

只返回 JSON。`;

    try {
      const { experimental_output, finishReason } = await generateText({
        model,
        prompt,
        maxOutputTokens: 8000,
        experimental_output: Output.object({ schema: ResultsSchema }),
      });
      if (finishReason === "length") {
        throw new Error("AI 输出被截断，请减少料理类型数量后重试");
      }
      return experimental_output.groups;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`AI 推荐失败：${msg}`);
    }
  });
