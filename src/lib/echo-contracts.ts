// ============================================================================
// Echo IO Contracts — 唯一事实源
// ----------------------------------------------------------------------------
// 所有模型调用的输入/输出 Schema 都在这里定义并导出。
//
// 原则：
//  1. 每个模型步骤的输出都是 JSON —— 一律通过 AI SDK `Output.object` + 这里的
//     Zod schema 强制约束（jsonMode = "always"），并在 Zod 层再做一次校验/兜底。
//  2. Schema 保持小、扁平、无长 enum、无 pattern/format/numeric bound，避免
//     Gemini structured-output 状态机爆炸导致空响应。
//  3. Prompt 不再重复列字段清单；prompt 只描述任务与语义，字段由 schema 强制。
//  4. 所有 AI 返回值必须过 Zod parse。parse 失败进入 fallback 策略（miss-only
//     retry / 缩小 batch / 兜底默认值），不允许静默。
//  5. 中国大陆地区拦截只发生在入口 city.functions.ts。本合同文件与主 workflow
//     不含任何大陆分支。
// ============================================================================

import { z } from "zod";

// ---------- 通用工具 ----------

const readableString = (value: unknown, fallback = ""): string => {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return fallback;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
};

// ---------- 结构化匹配明细（Verify Pass 用） ----------

export const MatchDetailSchema = z.preprocess(
  (v) => {
    if (typeof v === "string") return { label: v, status: "unknown", confidence: 50 };
    if (v && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      const label =
        readableString(obj.label) ||
        readableString(obj.text) ||
        readableString(obj.filter) ||
        readableString(obj.condition) ||
        readableString(obj.requirement) ||
        readableString(obj.note) ||
        readableString(obj.reason) ||
        readableString(obj.evidence) ||
        readableString(obj.summary) ||
        "Verification detail";
      return { ...obj, label, status: obj.status ?? "unknown", confidence: obj.confidence ?? 50 };
    }
    return { label: "", status: "unknown", confidence: 50 };
  },
  z.object({
    label: z.string().catch(""),
    status: z.enum(["ok", "unknown", "fail"]).catch("unknown"),
    confidence: z.coerce.number().min(0).max(100).catch(50).default(50),
  }),
);

export const HardFilterCheckSchema = z.preprocess(
  (v) => {
    if (typeof v === "string") return { filter: v, status: "unknown", note: v, confidence: 50 };
    if (v && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      const filter =
        readableString(obj.filter) ||
        readableString(obj.condition) ||
        readableString(obj.requirement) ||
        readableString(obj.text) ||
        "";
      const note =
        readableString(obj.note) ||
        readableString(obj.reason) ||
        readableString(obj.evidence) ||
        readableString(obj.summary) ||
        undefined;
      return { ...obj, filter, note, status: obj.status ?? "unknown", confidence: obj.confidence ?? 50 };
    }
    return { filter: "", status: "unknown", confidence: 50 };
  },
  z.object({
    filter: z.string().catch("").default(""),
    status: z.enum(["ok", "unknown", "fail"]).catch("unknown"),
    note: z.string().optional(),
    confidence: z.coerce.number().min(0).max(100).catch(50).default(50),
  }),
);

// ---------- 兼容旧 pipeline 的 AiPick（用于下游构造 Restaurant） ----------

export const AiPickSchema = z.object({
  placeId: z.string(),
  matchScore: z.number().min(0).max(100),
  matchTier: z.enum(["perfect", "high", "partial"]).catch("partial"),
  aiSummary: z.string(),
  pros: z
    .array(
      z.preprocess(
        (v) => (typeof v === "string" ? { text: v, source: null } : v),
        z.object({ text: z.string(), source: z.string().nullable().optional() }),
      ),
    )
    .default([]),
  cons: z
    .array(
      z.preprocess(
        (v) => (typeof v === "string" ? { text: v, source: null } : v),
        z.object({ text: z.string(), source: z.string().nullable().optional() }),
      ),
    )
    .default([]),
  matchDetails: z.array(MatchDetailSchema).catch([]).default([]),
  hardFilterChecks: z.array(HardFilterCheckSchema).catch([]).default([]),
});
export const AiRankingSchema = z.object({
  groups: z.array(z.object({ cuisine: z.string(), picks: z.array(AiPickSchema) })),
});
export const AiPickGroupSchema = z.object({ picks: z.array(AiPickSchema) });

// ============================================================================
// Pass 1 — Verify（核验）
// 输出：placeId + verificationStatus + hardFilterChecks + matchDetails
// 不含 matchScore、不含文案。schema 保持扁平以便 JSON 模式稳定。
// ============================================================================
export const AiVerifyPickSchema = z.object({
  placeId: z.string(),
  verificationStatus: z.enum(["ok", "unknown", "fail"]).optional(),
  hardFilterChecks: z.array(HardFilterCheckSchema).catch([]).default([]),
  matchDetails: z.array(MatchDetailSchema).catch([]).default([]),
});
export const AiVerifyGroupSchema = z.object({
  picks: z.array(AiVerifyPickSchema),
});
export const VERIFY_JSON_MODE = {
  name: "echo_eats_verify",
  description: "Verification result per candidate; no score, no copy.",
} as const;

// ============================================================================
// Pass 2 — Score（仅打分）
// 输出：[{ placeId, matchScore }]。schema 极简，最大化模型遵循率。
// 缺失走 miss-only retry；仍缺则兜底 60。
// ============================================================================
export const AiScorePickSchema = z.object({
  placeId: z.string(),
  matchScore: z.coerce.number().min(0).max(100),
});
export const AiScoreGroupSchema = z.object({
  scores: z.array(AiScorePickSchema),
});
export const SCORE_JSON_MODE = {
  name: "echo_eats_score",
  description: "Score candidates 0-100 based on verify results.",
} as const;
export const SCORE_FALLBACK = 60;

// ============================================================================
// Pass 3 — Copy（文案，仅 Top N）
// 输出：aiSummary + pros + cons
// ============================================================================
export const AiCopyPickSchema = z.object({
  placeId: z.string(),
  aiSummary: z.string().default(""),
  pros: z
    .array(
      z.preprocess(
        (v) => (typeof v === "string" ? { text: v, source: null } : v),
        z.object({ text: z.string(), source: z.string().nullable().optional() }),
      ),
    )
    .default([]),
  cons: z
    .array(
      z.preprocess(
        (v) => (typeof v === "string" ? { text: v, source: null } : v),
        z.object({ text: z.string(), source: z.string().nullable().optional() }),
      ),
    )
    .default([]),
});
export const AiCopyGroupSchema = z.object({
  picks: z.array(AiCopyPickSchema),
});
export const COPY_JSON_MODE = {
  name: "echo_eats_copy",
  description: "Editorial copy per top pick.",
} as const;

// ============================================================================
// Requirement Parsing — 语义聚类
// ============================================================================
export const SemanticClusterOutputSchema = z.object({
  clusters: z
    .array(z.object({ ids: z.array(z.number().int().nonnegative()).min(1) }))
    .default([]),
  dishClusters: z
    .array(z.object({ ids: z.array(z.number().int().nonnegative()).min(1) }))
    .default([]),
});
export const CLUSTER_JSON_MODE = {
  name: "echo_eats_semantic_clusters",
  description: "Group semantically equivalent requirement entries by id.",
} as const;

// ============================================================================
// Cuisine Expansion
// ============================================================================
export const CuisineExpansionSchema = z.object({
  primary: z.string(),
  synonyms: z.array(z.string()).default([]),
  negativeKeywords: z.array(z.string()).default([]),
});
export const CUISINE_EXPANSION_JSON_MODE = {
  name: "echo_eats_cuisine_expansion",
  description: "Localized cuisine query expansion.",
} as const;

// ---------- 类型导出（供外部消费） ----------
export type AiVerifyPick = z.infer<typeof AiVerifyPickSchema>;
export type AiVerifyGroup = z.infer<typeof AiVerifyGroupSchema>;
export type AiScorePick = z.infer<typeof AiScorePickSchema>;
export type AiScoreGroup = z.infer<typeof AiScoreGroupSchema>;
export type AiCopyPick = z.infer<typeof AiCopyPickSchema>;
export type AiCopyGroup = z.infer<typeof AiCopyGroupSchema>;
export type AiPick = z.infer<typeof AiPickSchema>;
export type SemanticClusterOutput = z.infer<typeof SemanticClusterOutputSchema>;
export type CuisineExpansionOutput = z.infer<typeof CuisineExpansionSchema>;
