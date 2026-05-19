# 中英双语切换方案

## 目标
- 全站支持 `zh`（简体中文）/ `en`（英文）两种语言。
- 首次访问按 `navigator.language` 自动选择，之后写入 `localStorage`，刷新/再访都按用户上次的选择。
- 顶部导航栏放一个轻量 EN / 中文 切换按钮，全站任意页面可一键切换。
- 切换语言后，**AI 生成的内容（推荐理由、优缺点、匹配项说明、需求结构化、料理扩展）也跟着切到对应语言**。

## 用户可见改动
- 每个页面顶部（`StepShell` 头部 + 结果页头部）右上角新增 `中文 / EN` 切换。
- 所有界面文案（步骤名、按钮、占位符、错误提示、SEO `<title>` / `<meta>`、404 / 错误页、反馈面板、NeedBubbles 等）按当前语言显示。
- 料理建议词（寿司、烧鸟…）在英文模式下显示英文（Sushi、Yakitori…），输入到搜索仍会经 `cuisine-expand` 本地化到目的地语言（与现状一致）。
- 结果页的 AI 文案、推荐理由、Pros/Cons、匹配标签、`reviewHighlights / commonComplaints` 等都使用当前界面语言。

## 技术方案（给开发者看）

### 1. i18n 基础设施（轻量，无新依赖）
新增 `src/lib/i18n/`：
- `dict.ts`：导出 `const dict = { zh: {...}, en: {...} } as const`，键扁平命名（如 `home.title`、`results.empty`、`common.next`）。
- `context.tsx`：`LanguageProvider` + `useT()` hook。
  - 初始值：`localStorage.getItem('echo-eats-lang')` → 否则 `navigator.language.startsWith('zh') ? 'zh' : 'en'`，SSR 阶段先用 `'zh'`，hydrate 后再纠正（避免 hydration mismatch：用 `useEffect` 切换并通过 state 触发 rerender）。
  - 暴露 `{ lang, setLang, t(key, vars?) }`，`t` 支持 `{name}` 占位符替换。
  - `setLang` 同时 `document.documentElement.lang = lang` 并写 localStorage。
- `LanguageToggle.tsx`：小型双态按钮组件。

在 `src/routes/__root.tsx` 用 `LanguageProvider` 包裹 `<Outlet />`；将 `<html lang>` 设为动态。

### 2. 替换硬编码文案
逐文件把中文字符串替换为 `t('...')`：
- `src/components/StepShell.tsx`（含 Step X / Y 文案 + 新增右上角 LanguageToggle）
- `src/routes/index.tsx`、`cuisines.tsx`、`requirements.tsx`、`results.tsx`
- `src/components/FeedbackPanel.tsx`、`src/components/NeedBubbles.tsx`
- `src/routes/__root.tsx`（404 / 错误页文案 + meta head）
- `src/lib/error-page.ts`（保持英文即可，作为兜底）

路由级 `head()` 改成在组件里使用 `useEffect` 设置 `document.title` 和 meta（或保留中文 SSR 默认值 + 客户端覆盖，不破坏 SEO 起点）。

料理建议词数组改为 `{ zh: '寿司', en: 'Sushi' }[]`，展示按 `lang` 取值，添加时也按当前语言写入输入框。

### 3. AI 输出语言贯通
所有 server function 增加 `uiLanguage: 'zh' | 'en'` 入参（由前端从 `useT()` 取到后传入），并在 prompt 里加一行明确语言要求：

- `parseRequirements`（`src/lib/echo.functions.ts` line 104）：把"所有内容用简体中文"改为模板：`所有自由文本字段用 ${uiLanguage === 'en' ? 'English' : '简体中文'}`。注意 `language`（搜索目标语言，BCP47）字段保留不变——它是给 Google Maps 用的，不受界面语言影响。
- `ai-rank`（line 1315 起）：`aiSummary` / `pros` / `cons` / `matchDetails.label` / `hardFilterChecks.note` 全部按 `uiLanguage` 输出；prompt 里"2-3 句中文"改为"2-3 sentences in ${uiLanguage}"；末尾来源括号（"（综合大众点评、小红书等网友评价）"）按语言切换为 "(based on Dianping / Xiaohongshu user reviews)"。
- `dianping` 总结 prompt（line 491、506）：`reviewHighlights` / `commonComplaints` 按 `uiLanguage` 输出。
- `cuisine-expand`：`primary` / `synonyms` 仍按城市语言（搜索用），不变；不需要传 uiLanguage。
- `searchRestaurants` 顶层把 `uiLanguage` 透传给上面三处。
- 缓存键：`cuisine-expand` 的内存缓存键不变；如未来给 dianping 摘要加缓存，键需加入 `uiLanguage`。

前端 `results.tsx` 触发查询时把 `lang` 一并传入 server function 的 input。

### 4. 持久化与默认值
- key：`echo-eats-lang`
- 初始检测顺序：localStorage → `navigator.language` → `'zh'`
- `setLang` 立即写 localStorage + 更新 `<html lang>`，结果页若已有缓存 results，**不会**自动重新请求 AI（避免计费），仅切换 UI；若用户想刷新 AI 文案，可手动重新搜索。会在 toggle 旁加一行小提示文字解释这一点。

## 不在本次范围
- URL 路径前缀（`/en`、`/zh`）：用户已确认不需要。
- 服务端按 `Accept-Language` 协商：保持 SSR 默认中文，前端 hydrate 后切换，足够。
- 其它语言（日 / 韩等）：架构已预留 `dict[lang]`，后续追加即可。

## 验收
1. 首次以英文浏览器访问 → 整站英文。
2. 点 EN / 中 切换 → 立即切换；刷新后仍保留。
3. 英文模式下走完一次搜索 → 结果页 AI 推荐理由 / Pros / Cons / 匹配标签全部为英文。
4. 中文模式回归测试，文案与现状一致。
