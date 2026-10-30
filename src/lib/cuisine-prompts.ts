// Shared semantic contract for resolution and localization, not a cuisine whitelist.
export const CUISINE_IDENTITY_RULES = `【品类语义完整性：适用于所有菜系与语言】
- 先理解原文中各词的修饰关系，再命名品类；同一短语内的「菜系/地域/料理基础 + 风格/经营形态」是一个完整品类，不能把修饰词拆成不受限定的另一品类。
- 「融合、创意、现代、传统」等风格必须保留其修饰的菜系；不能从「X 菜或融合 X 菜」输出「X 菜、融合料理」，应输出「X 菜、融合 X 菜」或合并成原意等价的具体品类。
- 每个最终品类必须独立成立：即使单独拿它搜索，也不能纳入用户没要求的其他菜系。同一原文分支里的限定必须一起保留，不能指望另一品类、偏好或后续排序补回。
- 区分「另一个独立菜系」与「同一菜系的风格变体」；用户确实表达独立备选时才扩展。不凭空继承限定到原文中真正独立的另一菜系，也不凭空增加新菜系。
- 仅在用户明确不限定基础菜系时，才可以使用「融合料理」这样的独立风格类别。
- 输出前逐个自查：有没有丢失菜系/地域/料理限定，或把一个修饰短语拆成更宽泛的类别？有则由你修正最终名称。禁止靠程序词表决定品类。`;

export function cuisineResolutionPrompt(input: {
  cuisines: string[];
  freeText: string;
  uiLanguage: "zh" | "en";
}): string {
  const lang = input.uiLanguage === "en" ? "English" : "简体中文";
  const task = input.cuisines.length
    ? `用户在表单里填写的品类：${input.cuisines.join("、")}。
结合填写的品类和原话，输出最终要搜索的品类（1-2 个，用规范、具体、能直接拿去地图搜索的品类名）。
- 原品类写得对、和原话不冲突 → 原样保留。
- 原品类有错字、多余字符或不规范（如「团丼」→「豚丼」、「早饭2」→「早餐」）→ 替换为规范写法（kind=typo）。
- 原话把整家店的形态说得更具体或与原品类矛盾 → 替换为更贴合的品类（kind=refine）。例：「寿司」+「一定要回转」→「回转寿司」；「早饭」+「想吃早午餐」→「早午餐」。
- 原话明确还想吃另一个品类或同一菜系的独立风格备选 → 补充完整品类（kind=expand），总数最多 2 个；语义相同则合并，不能靠删去限定词制造第二个品类。
菜品/口味不是品类：「拉面」+「鱼介拉面/豚骨」→ 保留「拉面」；「寿司」+「大腹」→ 保留「寿司」。
corrections 记录每一处改动，evidence 摘自用户原话（错字可为 ""）。没改动时 corrections 为 []。
只输出 JSON：{"cuisines":["最终品类"],"corrections":[{"from":"原品类","to":"新品类","kind":"typo|refine|expand","evidence":"原文片段"}]}`
    : `用户没有填品类。推断 1-2 个最贴合原话的具体料理品类；禁止「餐厅/restaurants」等通用词；推不出来返回 []。
只输出 JSON：{"cuisines":["最终品类"]}`;
  return `你是餐厅品类确定器。用户原话：「${input.freeText || "（无）"}」。输出语言：${lang}。
${CUISINE_IDENTITY_RULES}
${task}`;
}