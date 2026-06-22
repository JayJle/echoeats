## 先把现状说清楚

你说得对：当前实现不是最理想的。现在代码里去重分成两层：

1. **结构化解析后的服务端兜底去重**：`src/lib/echo.functions.ts`
   - 位置：AI 输出 JSON 后，`ParsedSchema.parse(output)` 之后，`return dedupeParsedConditions(parsed)`。
   - 也就是说它确实属于「结构化解析阶段的后处理」，在候选搜索/打分之前。
   - 但目前它不是纯语义去重，而是 `TOPIC_RULES` 正则关键词 + 文本 normalize。

2. **前端展示去重**：`src/routes/results.tsx`
   - 位置：渲染结果页时又做了一次 `uniqueDisplayItems`。
   - 这个确实应该移除；前端不应该再修数据，只应该展示结构化解析后的唯一结果。

当前问题为什么反复出现：因为服务端去重依赖关键词 topic，没覆盖到「环境好/环境要好一点/环境稍微好/环境精美」这种语义等价表达；而且关键词维护会一直漏，所以你说“不应该靠关键词”是对的。

## 目标

把所有条件去重都放在**结构化解析阶段**完成，前端不再做任何 hard/soft/negative/dish 的二次去重。

最终规则：

1. **跨区域重复**：同一个语义条件如果同时出现在 `negativeFilters / hardFilters / softPreferences`，只保留更高等级区域。
2. **同一区域重复**：同一个语义条件只保留一条，weight 取最高。
3. **权重合并**：无论同区还是跨区，只要语义等价，保留下来的那条 weight 使用所有重复项里的最高 weight。
4. **前端只展示**：前端不再根据关键词、文本或 topic 去重。

等级优先级沿用当前逻辑：

```text
negativeFilters > hardFilters > softPreferences
```

## 改动方案

### 1. 改结构化解析 prompt，让模型直接输出语义去重后的结果

更新 `src/lib/echo.functions.ts` 里 `## 边界与去重` prompt，从现在的三条短规则升级为明确规则：

- 输出前必须先做语义合并，而不是逐句抽取。
- 表达相同诉求的条件只能出现一次。
- 如果同一诉求有多种说法，例如：
  - “环境好一点”
  - “环境精美”
  - “环境好”
  - “环境稍微好”
  必须合并成一条，例如“环境好”。
- 如果同一诉求跨 hard/soft/negative 出现，只保留最高等级数组。
- 保留项的 weight 取所有同义重复项中的最高值。
- 不要因为用户重复说了多次就重复输出。

### 2. 新增一次 AI 语义去重后处理，替换关键词 topic 去重

在 `parseRequirements` 的结构化解析内部新增一个小的 dedupe pass：

- 输入：第一次结构化解析得到的 `hardFilters / softPreferences / negativeFilters`。
- 调用同一个 Lovable AI Gateway，让模型只做一件事：判断这些条件里哪些是语义重复，并输出合并后的三个数组。
- 明确要求它：
  - 不新增用户没说过的条件。
  - 不删除语义独立的条件。
  - 不改 `city/cuisines/dateTime/visitTime/searchStrategy` 等其它字段。
  - 只合并 hard/soft/negative 条件。
  - 每组重复条件按最高等级区域保留，weight 取最高。

这样“环境好/环境精美/环境稍微好”不靠关键词，而由模型按语义判断。

### 3. 保留一个极小的确定性兜底，但不再用 topic 关键词

移除 `TOPIC_RULES` 这套关键词归类。

服务端只保留：

- 完全相同文本 normalize 后去重。
- 完全相同菜品名 normalize 后去重。

真正的近义/同义判断交给 AI 语义 dedupe pass。

### 4. 去重接入点统一到结构化解析阶段

把解析流程改成：

```text
AI 初次结构化解析
→ schema 清洗
→ weight >= 0.8 soft 提升 hard
→ AI 语义去重 pass
→ 最小文本兜底去重
→ visitTime sanitize
→ 返回 parsed
→ 后续候选搜索/打分只使用已去重 parsed
```

这样候选池、筛选、排序看到的就是唯一条件集，而不是前端临时修出来的展示结果。

### 5. 移除前端去重

在 `src/routes/results.tsx` 删除：

- `DISPLAY_TOPIC_RULES`
- `displayConditionKey`
- `uniqueDisplayItems`
- `uniqueDisplayStrings`

并把：

```ts
const displayedHardFilters = uniqueDisplayItems(parsed.hardFilters);
const displayedSoftPreferences = uniqueDisplayItems(parsed.softPreferences);
const displayedNegativeFilters = uniqueDisplayItems(parsed.negativeFilters);
const displayedDishPreferences = uniqueDisplayStrings(parsed.dishPreferences);
```

改成：

```ts
const displayedHardFilters = parsed.hardFilters;
const displayedSoftPreferences = parsed.softPreferences;
const displayedNegativeFilters = parsed.negativeFilters;
const displayedDishPreferences = parsed.dishPreferences;
```

### 6. 增加结构化解析日志，方便你下次直接看

在服务端日志里打印：

- semantic dedupe 前的 hard/soft/negative。
- semantic dedupe 后的 hard/soft/negative。
- 被合并的组，例如：

```text
环境要好一点@0.4 + 环境精美@0.7 + 环境好@0.7 + 环境稍微好@0.4 -> 环境好@0.7 in softPreferences
```

## 验证用例

用你截图里的输入测试：

```text
我和我的朋友要在周六的十二点去吃这个午饭，我们想找的是一个早午餐，然后的话环境要好一点；这个定位不要高端，但是也不要低端，中高端的样子啊。菜品必须精美，然后的话环境精美，口碑要好，环境好，服务员态度要好。菜品的话最好是有班尼迪克蛋或者 French toast。然后的话最好是位于富人区或者位于一个安静的社区都可以。环境稍微好
```

期望：

- hardFilters：保留“菜品必须精美”一条。
- softPreferences：只保留一条“环境好/环境精美”类条件，weight 取 0.7。
- dishPreferences：保留“班尼迪克蛋”“French toast”。
- 前端不做任何去重，看到的就是结构化解析返回的唯一结果。

## 不做的事

- 不再继续扩充关键词规则。
- 不让前端继续兜底去重。
- 不改变 hard / negative 的筛选、打分、分桶逻辑。
