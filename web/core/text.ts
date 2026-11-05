// 文字工具：繁簡轉換（OpenCC）、全形轉半形、比對用的正規化（NORM-5）
import * as OpenCC from 'opencc-js';

type Conv = (s: string) => string;
let _toCn: Conv | null = null;
let _toTwp: Conv | null = null;
let _toTw: Conv | null = null;

/** 轉簡體（搜尋網易雲、比對用） */
export const toCn: Conv = (s) => (_toCn ??= OpenCC.Converter({ from: 'tw', to: 'cn' }))(s);
/** 簡轉繁＋台灣用語（LYR-5，整行用） */
export const toTwp: Conv = (s) => (_toTwp ??= OpenCC.Converter({ from: 'cn', to: 'twp' }))(s);
/** 簡轉繁（逐字時間軸用：只換字不換詞，字數不會變） */
export const toTw: Conv = (s) => (_toTw ??= OpenCC.Converter({ from: 'cn', to: 'tw' }))(s);

export const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
export const hasCjk = (s: string) => CJK_RE.test(s);
/** 有平假名 / 片假名 → 幾乎可以確定是日文 */
export const hasKana = (s: string) => /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(s);
/** 整份歌詞是日文：有假名的行至少三成（華語歌偶爾出現一個「の」不算） */
export function looksJapanese(lines: string[]): boolean {
  const ls = lines.filter((l) => l.trim());
  return ls.length > 0 && ls.filter(hasKana).length / ls.length >= 0.3;
}

export function halfWidth(s: string): string {
  return s.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/　/g, ' ');
}

/** 比對用：全形轉半形、轉小寫、去空白標點、繁簡統一 */
export function normKey(s: string | null | undefined): string {
  const t = halfWidth(String(s ?? '')).toLowerCase();
  return (hasCjk(t) ? toCn(t) : t).replace(/[\s\p{P}\p{S}]/gu, '');
}

/** 兩字串相似度 0~1：相同 1；包含關係 0.8~1；其他用 bigram Dice 係數 */
export function similarity(a: string, b: string): number {
  const x = normKey(a), y = normKey(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  if (l.includes(s)) return 0.8 + 0.2 * (s.length / l.length);
  const grams = (t: string) => {
    const cs = [...t];
    if (cs.length < 2) return cs;
    return cs.slice(1).map((c, i) => cs[i] + c);
  };
  const ga = grams(x), gb = grams(y);
  const bag = new Map<string, number>();
  for (const g of gb) bag.set(g, (bag.get(g) ?? 0) + 1);
  let hit = 0;
  for (const g of ga) {
    const n = bag.get(g) ?? 0;
    if (n > 0) { hit++; bag.set(g, n - 1); }
  }
  return (2 * hit) / (ga.length + gb.length);
}
