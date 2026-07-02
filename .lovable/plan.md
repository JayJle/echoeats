# 时间解析修复方案（双保险）

## 背景

最近一次 session：用户原话「周六晚上6:30」，被解析成 `hhmm:"06:30"`，应为 `"18:30"`。
同一句话上一次 session 解析正确。这是 LLM 不稳定，prompt 没明确"带分钟钟点 + 时段词"该如何套半区。

策略：prompt 先教会模型（覆盖 95%+ 场景），代码做确定性兜底（覆盖剩余 5%，含模型漂移、模型升级回归）。

---

## 改动 1：Prompt 补强（src/lib/echo.functions.ts，parseRequirements prompt 的 hhmm 规则段）

在 hhmm 规则段当前的"具体钟点"那一行下面追加一条**统一半区规则**和示例：

> **时段 + 钟点组合（强制）**：当原文同时出现时段词（早上/上午/morning、中午/noon、下午/afternoon、傍晚/evening、晚上/夜里/tonight/night、深夜/late night）和具体钟点（含 H:MM 或 H 点形式）时，钟点必须落到该时段对应的 12 小时半区：
> - 早上/上午/morning + 1~11 → AM（保持原值）
> - 中午/noon + 12 → 12:00；+ 1~11 → 跨过中午时按上下文
> - 下午/afternoon/傍晚/evening/晚上/night + 1~11 → PM（+12）
> - 深夜/late night + 1~5 → 次日凌晨，保持原值
>
> 示例：
> - 「晚上 6:30」→ 18:30
> - 「晚上六点半」→ 18:30
> - 「下午 2 点」→ 14:00
> - 「早上 7:30」→ 07:30
> - 「tonight at 6」→ 18:00
> - 「evening 7pm」→ 19:00（已含 pm 不再加 12）
> - 「中午 12 点」→ 12:00
> - 「凌晨 2 点」→ 02:00

## 改动 2：代码兜底（src/lib/echo.functions.ts，sanitizeVisitTime 函数）

在现有 evidence 子串校验通过之后、return 之前，加一段半区校正：

```ts
// 半区兜底：原文有明确时段词，且 hhmm 落在错误半区时强制翻转
const PM_WORDS = /(晚上|夜里|今晚|tonight|night|傍晚|evening|下午|afternoon|pm|p\.m\.)/i;
const AM_WORDS = /(早上|上午|清晨|morning|am|a\.m\.)/i;
const NOON_WORDS = /(中午|noon)/i;
const LATE_NIGHT_WORDS = /(深夜|凌晨|late\s*night|midnight)/i;

const src = (data.freeText ?? "");
const ev = vt.evidence ?? "";
// 用更大的窗口判断：优先看 evidence 周边，evidence 不足时退回 freeText
const ctx = ev.length >= 4 ? ev : src;

if (vt.hhmm && /^\d{2}:\d{2}$/.test(vt.hhmm)) {
  const [hh, mm] = vt.hhmm.split(":").map(Number);
  let fixed = vt.hhmm;
  const hasPm = PM_WORDS.test(ctx);
  const hasAm = AM_WORDS.test(ctx);
  const hasNoon = NOON_WORDS.test(ctx);
  const hasLate = LATE_NIGHT_WORDS.test(ctx);

  // 1) 晚上/下午/evening + 01~11 → +12
  if (hasPm && !hasAm && !hasLate && hh >= 1 && hh <= 11) {
    fixed = `${String(hh + 12).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  }
  // 2) 早上/morning + 13~23 → -12
  else if (hasAm && !hasPm && hh >= 13 && hh <= 23) {
    fixed = `${String(hh - 12).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  }
  // 3) 中午 + 00:xx → 12:xx（极少见但保护一下）
  else if (hasNoon && hh === 0) {
    fixed = `12:${String(mm).padStart(2, "0")}`;
  }

  if (fixed !== vt.hhmm) {
    console.warn(`[sanitizeVisitTime] half-period fix: ${vt.hhmm} → ${fixed} (ctx="${ctx}")`);
    return { ...parsed, visitTime: { ...vt, hhmm: fixed } };
  }
}
```

规则只在**明确出现时段词**且**模型给的半区与时段矛盾**时翻转，不会误伤 7pm/19:00 这种本来就对的；冲突情况（同时有"早上"和"晚上"）走默认不动，由 prompt 处理。

---

## 验证

1. 改完后用以下 7 句话各跑一次，确认 hhmm：
   - 周六晚上6:30 → 18:30
   - 周六晚上六点半 → 18:30
   - 下午 2 点 → 14:00
   - 早上 7:30 → 07:30
   - tonight at 6 → 18:00
   - 中午 12 点 → 12:00
   - 凌晨 2 点 → 02:00
2. 同时确认现有正确用例不被改坏：7pm sushi → 19:00、明天 12:30 → 12:30、Saturday brunch → 10:30。
3. 看 console，确认偶发的"half-period fix"日志只在 LLM 漂移时出现，便于后续观察。

## 不在本次改动范围

- 上一轮讨论中的"需求结构化解析 6 步"重构（拆抽取/打权重、输出字段拆分、合并规则等）继续待你拍板，本计划只修时间。
- 进度条节奏、`未指定` 删除等历史改动保持不变。
