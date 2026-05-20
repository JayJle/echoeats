## 目标

让你（产品 owner）能真实看到用户反馈，并能用反馈驱动迭代。当前后端已经在收集 `search_sessions` + `search_feedback`（已有 227 次搜索 / 6 条反馈），但**没有任何查看入口**——数据在数据库里，你看不到。

---

## 一、反馈数据模型：补齐缺口

现状已有：搜索上下文（city/cuisines/parsed/results_snapshot）+ 用户评价（up/down/原因/评论/选了哪家 or 站外）。

补充以下字段，让每条反馈"自带上下文"，无需我额外解读：

**`search_sessions` 加：**
- `user_agent text` — 区分移动/桌面
- `lang text` — 中/英用户行为差异
- `result_count int` — 当时返回了几家
- `had_error bool` + `error_stage text` — 流程中是否报错（Google/点评/Tabelog/AI）

**`search_feedback` 加：**
- `nps int (1–5)` — 一个数字代替模糊的 up/down，能算趋势
- `chosen_reason text[]` — 用户为什么选这家（味道/位置/评分/AI 总结说服力）
- `would_recommend bool` — 是否愿推荐 Echo Eats
- `contact text` — 可选邮箱，用户希望被回访

**新增 `feedback_events` 表（事件级，可选轻量）：**
记录关键交互（点开某家、点击外链、复制地址、切平台），用于补足"用户没填表但行为已经说明问题"。

---

## 二、查看入口：管理后台 `/admin/feedback`

一个受保护的页面（密码保护，不接入完整 auth），三个核心视图：

### 1. Dashboard（顶部概览）
- 7/30 天搜索量、反馈率、👍/👎 比、平均 NPS
- Top 5 高频 down reasons
- "选了站外"占比（衡量我们推荐 vs 用户实际想吃的差距）
- 错误率分平台

### 2. Feedback Feed（核心）
每条反馈卡片展示：
```
[👎] 东京 · 拉面 · 中文 · 移动端 · 2分钟前
原始需求："不要太油，最好排队不久"
返回结果：一蘭、Afuri、Ichiran Roppongi（共 3 家）
用户选择：站外 "面屋武藏"
原因：① 推荐的不够地道  ② 没考虑排队
评论："这几家都太游客了"
[查看完整 session JSON ▾]
```
按 down / 选站外 / 有评论筛选，按时间倒序。

### 3. Session Explorer
点开一条 → 看到当时 parsed 后的查询、完整 results_snapshot、用户最终选择。能"复现现场"才有诊断价值。

---

## 三、让反馈"主动找到你"

光有后台你不会每天看。加两个推送：

1. **每日邮件摘要**（用 Resend / 你已有的 ElevenLabs 同等级 connector）：
   昨日 N 次搜索、M 条反馈、负面原因 top 3、有评论的逐条列出。

2. **负面反馈即时通知**：用户提交 👎 或留下评论时，触发邮件到你。

实现方式：TanStack server function + cron（pg_cron 调用 `/api/public/daily-digest`，带签名校验）。

---

## 四、提升填写率（当前 227 搜索 / 6 反馈 ≈ 2.6%）

产品改动，不在此 plan 实施，仅列出建议供后续：
- 用户点击某家餐厅外链时，1 秒后浮出"这家如何？👍👎"轻量条
- 24h 后如果同一 anon_id 又来搜了，弹"上次去 XX 了吗？"
- 主动反馈按钮挪到结果卡片内联（"这家不合适？"）

---

## 五、实施范围（本轮要做的）

**数据库迁移：**
1. `search_sessions` 加 `user_agent / lang / result_count / had_error / error_stage`
2. `search_feedback` 加 `nps / chosen_reason / would_recommend / contact`
3. 两个表加 RLS：仅 service role 可读写（前端通过 server fn 写入；admin 后台通过 server fn + 密码读）
4. 创建 admin 用 view，预 join session+feedback

**前端：**
1. 修改 `FeedbackPanel`：加 1–5 星 NPS + chosen_reason chip + 可选邮箱
2. `createSearchSession` / `submitSearchFeedback` 接收新字段
3. 新增 `/admin/feedback` 路由（密码 gate，密码存 secret `ADMIN_PASSWORD`）
   - Dashboard 概览
   - Feedback Feed（带筛选）
   - Session Explorer 详情抽屉

**服务端：**
1. 新增 `admin.functions.ts`：`getFeedbackStats` / `listFeedback` / `getSession`（全部校验 `ADMIN_PASSWORD`）
2. 新增 `/api/public/daily-digest` 路由，pg_cron 每日 09:00 调用，发送邮件摘要
3. （可选第二步）负面反馈即时通知：在 `submitSearchFeedback` 里，若 overall=down，触发邮件

**Secrets 需要你提供：**
- `ADMIN_PASSWORD`（你自己设一个）
- 邮件服务：建议接 **Resend** connector（如果你同意，我会在实施时通过 connector 流程引导）
- 你希望接收摘要的邮箱地址

---

## 技术细节

- 管理后台密码用 HttpOnly cookie + server fn 校验，不在 localStorage 存
- 邮件 digest endpoint 用 HMAC 签名防滥用
- view 命名 `feedback_with_session`，admin 后台只查 view，避免暴露原表结构
- 所有 admin server fn 用 `supabaseAdmin`（不走 RLS），但入口层强制密码

---

## 需要你确认

1. **管理后台访问方式**：单密码 gate（最简）/ Magic link / 接入 Lovable Cloud auth 并把你的邮箱加白名单？
2. **邮件服务**：接 Resend？还是你已有偏好（SendGrid / 不要邮件，只要后台）？
3. **NPS 替代 up/down**：愿意吗？（更可量化，但用户填写阻力略升）
4. **接收摘要的邮箱**

确认后我开始实施。
