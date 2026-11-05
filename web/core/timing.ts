// 字的時間分配（OVL-8）與行內進度
import type { LyricLine } from './types';

const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** 權重：中日韓一字 = 1；英文單字依音節估計（約 3 字母 = 1）；標點 0.3；空白 0 */
export function tokenWeight(tok: string): number {
  const t = tok.trim();
  if (!t) return 0;
  if (CJK_CHAR.test(t)) return [...t].filter((c) => CJK_CHAR.test(c)).length || 1;
  if (/[A-Za-z0-9]/.test(t)) return Math.max(1, t.replace(/[^A-Za-z0-9]/g, '').length / 3);
  return 0.3;
}

export function weight(text: string): number {
  let w = 0;
  for (const tok of splitTokens(text)) w += tokenWeight(tok);
  return Math.max(w, 1);
}

/** 拆成可以逐一填色的單位：每個中文字、每個英文單字（含後面的空白）、每個標點 */
export function splitTokens(text: string): string[] {
  return text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]\s*|[A-Za-z0-9'’]+\s*|\s+|[^\s]/gu) ?? [];
}

export interface Token { text: string; startMs: number; endMs: number }

/** 一行的填色單位與時間。有逐字時間軸就照用；沒有就依權重把整行時間分下去 */
export function lineTokens(line: LyricLine): Token[] {
  if (line.words?.length) return line.words.map((w) => ({ text: w.text, startMs: w.startMs, endMs: Math.max(w.endMs, w.startMs + 1) }));
  const toks = splitTokens(line.text);
  const ws = toks.map(tokenWeight);
  const total = ws.reduce((a, b) => a + b, 0) || 1;
  const dur = Math.max(1, line.endMs - line.startMs);
  let acc = 0;
  return toks.map((text, i) => {
    const startMs = line.startMs + (acc / total) * dur;
    acc += ws[i];
    return { text, startMs, endMs: line.startMs + (acc / total) * dur };
  });
}

export interface Measured { x: number; w: number; startMs: number; endMs: number }

/** 目前時間對應到行內第幾個像素（可半字填色） */
export function progressPx(tokens: Measured[], t: number): number {
  if (!tokens.length) return 0;
  let px = 0;
  for (const k of tokens) {
    if (t >= k.endMs) { px = k.x + k.w; continue; }
    if (t > k.startMs) px = k.x + k.w * ((t - k.startMs) / Math.max(1, k.endMs - k.startMs));
    else px = Math.max(px, k.x);
    break;
  }
  return px;
}

/** 二分搜尋：最後一個 startMs ≤ t 的行，沒有則 -1 */
export function lineIndexAt(lines: { startMs: number }[], t: number): number {
  let lo = 0, hi = lines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].startMs <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}
