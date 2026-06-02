# 首页瘦身 + 料理品类扩充

## 1. 首页（`src/routes/index.tsx` + dict）
- 删掉标题下方的 `step1.hint` 一行（"例如 Tokyo / 东京、Shanghai / 上海、Paris"）。具体做法：给 `StepShell` 传 `hint={undefined}`，组件本身不改。
- 把"举例"提示挪到输入框 placeholder：
  - zh：`例如 Tokyo / 东京、Shanghai / 上海、Paris`
  - en：`e.g. Tokyo, Shanghai, Paris`
- 大众点评反爬提示（`home.notice.dianping`）保留不动。

## 2. 料理品类扩充（`src/lib/i18n/dict.ts` 的 `CUISINE_SUGGESTIONS`）
- 移除：`蟹料理 / Crab`
- 新增并重排，覆盖日 / 中 / 韩 / 东南亚 / 欧美 / 酒水甜品等常见品类，按使用频率排序，目标在 812px 视口刚好两行：

| zh | en |
|---|---|
| 寿司 | Sushi |
| 拉面 | Ramen |
| omakase | Omakase |
| 烧鸟 | Yakitori |
| 居酒屋 | Izakaya |
| 牛排 | Steak |
| 烤肉 | Korean BBQ |
| 火锅 | Hotpot |
| 中餐 | Chinese |
| 粤式点心 | Dim Sum |
| 意餐 | Italian |
| 法餐 | French |
| 泰餐 | Thai |
| 印度菜 | Indian |
| 墨西哥菜 | Mexican |
| 汉堡 | Burger |
| 早午餐 | Brunch |
| 甜品 | Dessert |
| 咖啡 | Cafe |
| 酒吧 | Bar |

共 20 个，确保两种语言文案都齐全；现有的 `step2.placeholder` 里有"蟹料理"也一并替换成新词（zh：`牛排,居酒屋,拉面`；en：`steak, ramen, izakaya`）。

## 3. 不动的部分
- StepShell、其它路由、AI 解析逻辑、cuisine-expand 同义词都不需要改。这些品类用户输入后会照常走现有的本地化扩展。

---

## 🧒 白话方案
首页那行小字直接删掉，提示挪到输入框里，让标题更干净。料理选择页把建议词扩充到 20 个，覆盖更多国家和品类，下次访问就能看到两整行可点的标签。中英文都同步加。

## 👀 用户视角变化
- 首页只剩标题 + 输入框 + 反爬提示 + 下一步按钮。
- 料理页底下气泡明显变密、变国际化。

## 💰 成本与副作用
零额外调用；只改前端文案和数组。无风险。
