# 精简品类泡泡为 11 个（两行）

将 `src/lib/i18n/dict.ts` 中的 `CUISINE_SUGGESTIONS` 从 20 个缩减为 11 个，控制在两行显示。

保留的 11 个品类：
| 中文 | 英文 |
|------|------|
| 寿司 | Sushi |
| 拉面 | Ramen |
| 烧鸟 | Yakitori |
| 牛排 | Steak |
| 烤肉 | BBQ |
| 火锅 | Hotpot |
| 中餐 | Chinese |
| 意餐 | Italian |
| 泰餐 | Thai |
| 酒吧 | Bar |
| 咖啡 | Cafe |

覆盖日/中/韩/泰/意 等主流菜系 + 酒水轻食，保持双语兼容。
