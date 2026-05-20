## 问题

`/admin/feedback` 一直显示"加载中…"。从浏览器控制台抓到真实错误：

```
ADMIN_SESSION_SECRET missing or too short (>=32 chars)
```

`adminCheckAuth` 在初始化 session 配置时就抛错，前端的 `check()` Promise reject，`setLoading(false)` 永远不执行，所以一直卡在加载中。

当前 `ADMIN_SESSION_SECRET` 这个密钥已存在，但长度不足 32 个字符（用于加密 cookie，必须 ≥32 字符）。

## 修复

**1. 更新 `ADMIN_SESSION_SECRET` 密钥**
弹出安全表单让你重新输入一个 ≥32 字符的随机字符串（用于加密管理员登录 cookie，不是登录密码）。可以用任意随机串，例如：
`echo-eats-admin-session-please-rotate-2026-xyz`

`ADMIN_PASSWORD`（你的实际登录密码）保持不变。

**2. 让 `adminCheckAuth` 不再因 session 配置错误卡死页面**
即使将来 secret 出问题，也应返回 `{ authed: false }` 而不是抛错，这样至少能看到登录界面（虽然登录会失败），便于诊断。在 `src/lib/admin.functions.ts` 中对 `adminCheckAuth` 加 try/catch。

**3. 前端兜底**
在 `src/routes/admin.feedback.tsx` 的第一个 `useEffect` 里加 try/catch，确保即便 server fn 抛错也会 `setLoading(false)` 并显示登录框（带错误提示），不再永久"加载中"。

## 实施步骤

1. 调用 `update_secret` 让你重设 `ADMIN_SESSION_SECRET`（≥32 字符）
2. 改 `adminCheckAuth` + `admin.feedback.tsx` 加错误兜底
3. 重新发布后，访问 `/admin/feedback` 应能看到密码登录框
