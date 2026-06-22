# AI 核验 L1 一次成功优化方案

## 一、问题诊断（基于日志）

L1（`Output.object` 结构化）失败的两类根因：

| 根因 | 触发条件 | 占比（日志推断） |
|---|---|---|
| **A. 输出截断**（`finishReason=length`） | 8 家店 × 大量必填字段 × 长 note/label，超出 12000 token | 约 70% |
| **B. schema 校验失败** | Gemini 偶发字段缺失/类型错（`confidence` 写成字符串、`matchDetails` 长度不符） | 约 30% |

两者修复方向一致：**让 L1 输出更紧凑、更确定**。

## 二、修改方案（4 项联动）

### 修改 1：批次从 8 → 6（核心）
`src/lib/echo.functions.ts:1554`
```
const AI_BATCH_SIZE = 6;  // 原 8
```
输出 token 直接砍 25%，是降低截断率最有效的单点。

### 修改 2：精简 Schema（去掉非必要的强约束字段）
`src/lib/echo.functions.ts:738-753` `AiPickSchema`：

- `matchTier` 从必填枚举 → **移除**（后端从 `matchScore` 推导，代码里已有 `tierFromScore` 函数）
- `pros / cons` 的 `source` 从可选 → **彻底移除**（前端基本没用到，节省 token）
- `MatchDetailSchema.confidence` 默认 50、`HardFilterCheckSchema.confidence` 同样，**移除 confidence 必填**，改成可选；prompt 里也不再强调"必须给"

预期：每家店输出减少约 30% token。

### 修改 3：Prompt 增加"输出格式硬约束"段（移到铁律最前）

L1 prompt 当前完全没有格式硬约束（那段只在 L2/L3 才追加）。新增段落，插在"## 铁律"之前：

```
## 输出长度硬约束（违反即视为失败）
- 本批最多 {{batchSize}} 家店，picks 数组长度必须严格等于本批候选数。
- 每家店：
  - aiSummary：≤ 60 字
  - pros：最多 2 条；每条 text ≤ 30 字
  - cons：最多 2 条；每条 text ≤ 30 字
  - matchDetails[].label：≤ 30 字
  - hardFilterChecks[].note：≤ 30 字
- 不要输出 reasoning、解释、markdown、注释。直接产出 JSON 结构。
- 严禁省略某家店；如证据不足，写 verificationStatus="unknown" + 简短说明即可，不要跳过。
```

### 修改 4：精简 prompt 主体（删冗余说明）

当前 prompt 约 2800 字中文，其中：
- "## pros/cons 写作规范" 整段约 500 字 → **压成 5 行铁律**
- 语言指令段 800 字 → 保留禁止示例 1 个、正确示例 1 个（节省 400 字）
- "状态判定依据"重复说明 → 压成 3 行

输入 prompt 砍约 40%，模型读得更快，也减少把示例当成输出格式抄错的几率。

## 三、预期效果

| 指标 | 修改前 | 修改后（预估） |
|---|---|---|
| 单批 L1 成功率 | ~40% | **~85%** |
| 单批 L1 输出 token | 3000-6000 | 1500-2500 |
| 单批耗时（L1 命中） | 30-50s | **15-25s** |
| 单批耗时（走到 L3） | 100-150s | 50-80s（兜底也变快） |
| **整个 AI 核验阶段** | **152s** | **~40s** |
| AI 调用次数（3 菜系组 × 31 店均值） | 12 批 × 平均 2.3 轮 ≈ 28 次 | 18 批 × 平均 1.2 轮 ≈ 22 次 |
| 总成本 | 基准 | 略低（输出 token 砍 50%+） |

## 四、风险与权衡

| 风险 | 影响 | 缓解 |
|---|---|---|
| 批次变小 → API 调用变多 | 并发 + 网关 QPS 上限可能排队 | 当前并发上限够用（日志显示从未排队） |
| 移除 `confidence` 必填 | 没有 confidence 时无法自动降为 unknown | 改为可选，缺失时代码侧默认按 70 处理 |
| aiSummary/pros/cons 压短 | 文案密度降低 | 60/30 字仍够展示，前端卡片本来就截断 |
| 移除 `matchTier` | 改用后端推导 | 已有 `tierFromScore`，无需新代码 |

## 五、改动文件清单

- `src/lib/echo.functions.ts`
  - L1554：`AI_BATCH_SIZE = 8 → 6`
  - L738-753：精简 `AiPickSchema`（去 `matchTier`、`source`）
  - L729-735：`confidence` 改可选
  - L1658-1723：精简 prompt 主体 + 插入"输出长度硬约束"段
  - L1860+：merge 处用 `tierFromScore(pick.matchScore)` 补回 `matchTier`

不动：L2/L3 兜底逻辑、Yelp/Tabelog 部分、评分聚合、前端。

## 六、验证方法

实施后跑一次同条件搜索（3 菜系 × 30 店），看日志：
- L1 一次成功的菜系组数应 ≥ 2/3
- `[Echo/AI-rank] all N group(s) done in Xms` X 应从 150000 降到 40000-60000
- 总搜索响应时长从 4 分钟降到 ~2 分钟