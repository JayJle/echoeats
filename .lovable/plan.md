## 目标
- **缩短前置流程**：用户只需输入"城市"+"料理"，描述可选，直接出结果。
- **结果页可继续夹条件**：边看边补充需求并重新筛选。
- **结果页加两个动作**：
  - **重新搜索**：清空所有条件回到首页。
  - **再次搜索**：用当前条件再跑一次（不改条件）。

## 新流程

```text
/  (城市)
   ↓
/cuisines  (料理 + 可选描述 + [开始搜索] 按钮)
   ↓ 后台一次性 parse + search
/results
```

`/when`、`/requirements`、`/confirm` 三个独立步骤页 **从主流程移除**（路由文件保留但不再链入；`/confirm` 仍保留入口，从结果页"编辑需求"可选进入做精细编辑，但默认不走）。

## 改动清单

### 1. 后端 `src/lib/echo.functions.ts`
- `RequirementsInputSchema` 的 `date` 改为 `z.string().default("")`（可选）。
- `parseRequirements` prompt 中：当 date 为空时说明"用户未指定日期，dateTime 字段填 '未指定'，不要把日期当硬条件"。
- 不动 search 主体逻辑。

### 2. `src/routes/cuisines.tsx`
- 在原料理输入下方加一个 `Textarea`（可选描述，placeholder 与原 requirements 页一致）。
- 提交按钮文案改为 **"AI 帮我找餐厅 →"**，点击后：
  1. `setCuisines` + `setFreeText` + `setDate("")`
  2. 调用 `parseRequirements`（与现 requirements 页同款逻辑）
  3. 调用 `searchRestaurants`
  4. 跳 `/results`
- 显示统一的 loading 文案（"AI 正在理解需求…" → "AI 正在搜索餐厅…"）和错误处理（429 / 402 / 其他）。

### 3. `src/routes/results.tsx` 新增三块
- **重新搜索**（已存在）：保留底部按钮，行为不变（reset store 回 `/`）。
- **再次搜索**（新）：放在头部 `编辑需求` 按钮旁，点击后用当前 `parsed` 再跑一次 `searchRestaurants`，loading 期间页面遮罩 + 刷新 `results`。
- **补充条件面板**（新，放在结果列表上方）：
  - 折叠卡片，标题"➕ 继续补充条件"，展开后显示 textarea + "应用并重新搜索" 按钮。
  - 提交时：把新文本与原 `freeText` 拼接（"\n\n[补充] " 前缀），重新 `parseRequirements` + `searchRestaurants`，更新 store，原地刷新。
  - 成功后清空补充输入框并自动收起。

### 4. `/when` 与 `/requirements` 页面
- 路由文件保留（避免 routeTree 重生成失败和老 URL 访问），但 `/when` 页面顶部 `useEffect` 改为直接 redirect 到 `/cuisines`（防呆）。
- `/requirements` 仍可工作，作为"编辑需求"进阶入口。

## 不动的部分
- 后端搜索主流程、Tabelog 抓取、排序、价格筛选逻辑全部不变。
- `useQueryStore` 字段不增减（`date` 允许为空字符串，已经是 string）。
- `/results` 卡片渲染、`FeedbackPanel` 不动。

## 风险与边界
- 历史 sessionStorage 中可能有旧 `date` 值，新流程 setDate("") 会覆盖；用户从老链接进 `/when` 自动跳 `/cuisines`。
- 后端 prompt 在 dateTime="未指定" 时需要明确不把"今天/明天营业"当硬条件，避免误判。
- "再次搜索"在条件未变时的结果可能与上次相同（AI 有随机性，通常会略有差异），属预期。

## 验证
- 进入首页→输入"东京"→不填描述直接点"AI 帮我找餐厅"→应在 ~10–20s 内看到结果。
- 在结果页展开补充条件输入"预算 8000 日元以内"→应用→列表刷新且原料理分组保留。
- 点"再次搜索"→loading→列表刷新。
- 点"重新搜索"→回首页且所有输入清空。