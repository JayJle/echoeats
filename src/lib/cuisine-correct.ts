// Guarded cuisine correction: the parser may only fix an obvious typo or refine a cuisine into a
// shop-format subtype (寿司 → 回转寿司). Dishes/flavours (鱼介拉面) must stay dish conditions.

export type CuisineCorrection = {
  from: string;
  to: string;
  kind: "typo" | "refine";
  evidence: string;
};

// Shop-format markers: the whole restaurant is this format, not a single dish.
const SHOP_FORMAT_RE =
  /(回转|回転|迴轉|かいてん|conveyor|kaiten|立食|立ち食い|立吞|立ち飲み|standing|自助|放題|buffet|all[- ]you[- ]can[- ]eat|食放题|食べ放題|吃到饱|食堂|屋台|路边摊|大排档|家庭餐厅|ファミレス|居酒屋|烧鸟店|焼鳥店|酒场|酒場|food court|美食广场|フードコート)/i;

const HARD_WORD_RE = /(必须|一定|务必|只要|只吃|只去|非.{0,4}不可|得是|要是|must|have to|has to|only|need)/i;

const norm = (s: string) => s.toLowerCase().replace(/[\s\u3000·・,，。.!！?？]/g, "");

function editDistance(a: string, b: string): number {
  const A = [...a];
  const B = [...b];
  const dp = Array.from({ length: A.length + 1 }, (_, i) => [i, ...Array(B.length).fill(0)]);
  for (let j = 1; j <= B.length; j++) dp[0][j] = j;
  for (let i = 1; i <= A.length; i++)
    for (let j = 1; j <= B.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1));
  return dp[A.length][B.length];
}

export function validateCuisineCorrection(
  c: CuisineCorrection,
  rawText: string,
): { ok: true } | { ok: false; reason: string } {
  const from = norm(c.from);
  const to = norm(c.to);
  if (!from || !to || from === to) return { ok: false, reason: "empty-or-same" };
  if (c.kind === "typo") {
    const len = Math.max([...from].length, [...to].length);
    if (Math.abs([...from].length - [...to].length) > 1) return { ok: false, reason: "typo-length" };
    const d = editDistance(from, to);
    if (d > 2 || d >= len) return { ok: false, reason: `typo-distance=${d}` };
    return { ok: true };
  }
  if (c.kind === "refine") {
    if (!to.includes(from)) return { ok: false, reason: "refine-not-subtype" };
    if (!SHOP_FORMAT_RE.test(c.to)) return { ok: false, reason: "refine-not-shop-format(dish?)" };
    const ev = norm(c.evidence ?? "");
    if (!ev || !norm(rawText).includes(ev)) return { ok: false, reason: "evidence-not-in-text" };
    if (!HARD_WORD_RE.test(c.evidence)) return { ok: false, reason: "evidence-not-hard" };
    return { ok: true };
  }
  return { ok: false, reason: "unknown-kind" };
}

// Applies validated corrections to the user's cuisine list (order preserved, no duplicates).
export function applyCuisineCorrections(
  userCuisines: string[],
  proposals: CuisineCorrection[],
  rawText: string,
): { cuisines: string[]; applied: CuisineCorrection[]; rejected: { c: CuisineCorrection; reason: string }[] } {
  const applied: CuisineCorrection[] = [];
  const rejected: { c: CuisineCorrection; reason: string }[] = [];
  const out = [...userCuisines];
  for (const c of proposals) {
    const idx = out.findIndex((u) => norm(u) === norm(c.from));
    if (idx < 0) {
      rejected.push({ c, reason: "from-not-user-cuisine" });
      continue;
    }
    const v = validateCuisineCorrection(c, rawText);
    if (!v.ok) {
      rejected.push({ c, reason: v.reason });
      continue;
    }
    out[idx] = c.to.trim();
    applied.push(c);
  }
  return { cuisines: [...new Set(out)], applied, rejected };
}
