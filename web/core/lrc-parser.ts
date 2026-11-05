// 歌詞解析（LYR-4）：標準 LRC、增強型 LRC（<mm:ss.xx> 逐字）、網易 yrc（逐字）、酷狗 krc（逐字）、翻譯行
import { hasCjk, hasKana, looksJapanese, normKey, toTw, toTwp } from './text';
import { weight } from './timing';
import type { LyricDoc, LyricLine, LyricWord, RawLyrics } from './types';

const NOTICE = /^【[^】]*】$|著作[权權]|版[权權]所有|未[经經].{0,12}[许許]可|^\s*\[?\s*(纯音乐|純音樂).{0,10}请欣赏/;
const CREDIT = /^(作词|作曲|编曲|编辑|制作|制作人|监制|混音|母带|录音|和声|和音|吉他|贝斯|鼓|键盘|弦乐|出品|发行|统筹|策划|版权|词|曲|演唱|原唱|OP|SP|Producer|Lyricist|Lyrics|Composer|Arranger|Written by|Composed by|作詞|編曲|製作|製作人|監製|錄音|和聲|貝斯|鍵盤|弦樂|發行|統籌|策劃|版權)\s*[:：]/i;

const TIME = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const WORD_TIME = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;

const toMs = (m: string, s: string, f?: string) => (+m * 60 + +s) * 1000 + (f ? +f.padEnd(3, '0').slice(0, 3) : 0);

/** 「吉他&貝斯：」「總監制：」「Synthesizer Programming：」這類組合職稱：冒號前面那段含有製作職稱就算 */
const CREDIT_KEY = /作[词詞曲]|[编編]曲|[词詞]曲|制作|製作|[监監][制製]|混音|母[带帶]|[录錄]音|和[声聲音]|吉他|[贝貝]斯|鼓|[键鍵][盘盤]|弦[乐樂]|出品|[发發]行|[统統][筹籌]|[策企][划劃]|版[权權]|配唱|人[声聲]|合成器|\b(op|sp|producer|produced|lyrics?|lyricist|composer|composed|arranger|arranged|arrangement|written|programming|programmer|synth\w*|guitars?|bass|drums?|piano|keyboards?|strings?|mix\w*|master\w*|record\w*|engineer\w*|vocals?|chorus|director)\b/i;

export function isJunk(text: string): boolean {
  if (!text || CREDIT.test(text) || NOTICE.test(text)) return true;
  const head = text.match(/^([^:：]{1,30})[:：]/)?.[1];
  return !!head && CREDIT_KEY.test(head);
}

interface Draft { startMs: number; endMs?: number; text: string; words?: LyricWord[] }

/** 標準 / 增強型 LRC → 行（尚未補結束時間） */
export function parseLrc(src: string): Draft[] {
  const out: Draft[] = [];
  let offset = 0;
  for (const raw of String(src).split(/\r?\n/)) {
    const off = raw.match(/^\s*\[offset:\s*([+-]?\d+)\s*\]/i);
    if (off) { offset = +off[1]; continue; }
    const times = [...raw.matchAll(TIME)];
    if (!times.length) continue;
    const body = raw.replace(TIME, '');
    const wordTags = [...body.matchAll(WORD_TIME)];
    // LRC 的 offset：正數 = 歌詞提早
    const lineStarts = times.map((m) => toMs(m[1], m[2], m[3]) - offset);
    if (wordTags.length) {
      const words: LyricWord[] = [];
      for (let i = 0; i < wordTags.length; i++) {
        const tag = wordTags[i];
        const from = (tag.index ?? 0) + tag[0].length;
        const to = wordTags[i + 1]?.index ?? body.length;
        const text = body.slice(from, to);
        const startMs = toMs(tag[1], tag[2], tag[3]) - offset;
        const next = wordTags[i + 1];
        const endMs = next ? toMs(next[1], next[2], next[3]) - offset : startMs + 600;
        if (text) words.push({ text, startMs, endMs });
        else if (words.length) words[words.length - 1].endMs = startMs;   // 結尾的空標記 = 最後一字結束
      }
      const text = words.map((w) => w.text).join('').trim();
      if (isJunk(text)) continue;
      // 同一行有多個時間標記時，逐字時間依行起點平移
      for (const ls of lineStarts) {
        const shift = ls - (words[0]?.startMs ?? ls);
        out.push({
          startMs: ls,
          endMs: (words[words.length - 1]?.endMs ?? ls) + shift,
          text,
          words: words.map((w) => ({ text: w.text, startMs: w.startMs + shift, endMs: w.endMs + shift })),
        });
      }
    } else {
      const text = body.trim();
      if (isJunk(text)) continue;
      for (const ls of lineStarts) out.push({ startMs: ls, text });
    }
  }
  return out;
}

/** 網易 yrc：[行起,行長](字起,字長,0)字… ；開頭的 JSON 行是製作人員，略過 */
export function parseYrc(src: string): Draft[] {
  const out: Draft[] = [];
  for (const raw of String(src).split(/\r?\n/)) {
    const lm = raw.match(/^\[(\d+),(\d+)\](.*)$/);
    if (!lm) continue;
    const words: LyricWord[] = [...lm[3].matchAll(/\((\d+),(\d+),\d+\)([^(]*)/g)].map((w) => ({
      text: w[3], startMs: +w[1], endMs: +w[1] + +w[2],
    })).filter((w) => w.text);
    const text = words.map((w) => w.text).join('').trim();
    if (isJunk(text)) continue;
    out.push({ startMs: +lm[1], endMs: +lm[1] + +lm[2], text, words });
  }
  return out;
}

/**
 * 酷狗 krc：[行起,行長]<字相對行起,字長,0>字…
 * 開頭常有一行「歌手 - 歌名」，依 [ar:] [ti:] 標籤略過
 */
export function parseKrc(src: string): Draft[] {
  const text = String(src);
  const tag = (k: string) => text.match(new RegExp(String.raw`^\[${k}:([^\]]*)\]`, 'm'))?.[1].trim() ?? '';
  const ar = tag('ar'), ti = tag('ti');
  const header = ar && ti ? new Set([normKey(ar + ti), normKey(ti + ar)]) : new Set<string>();
  const out: Draft[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const lm = raw.match(/^\[(\d+),(\d+)\](.*)$/);
    if (!lm) continue;
    const ls = +lm[1];
    const words: LyricWord[] = [...lm[3].matchAll(/<(\d+),(\d+),\d+>([^<]*)/g)].map((w) => ({
      text: w[3], startMs: ls + +w[1], endMs: ls + +w[1] + +w[2],
    })).filter((w) => w.text);
    const line = words.map((w) => w.text).join('').trim();
    if (isJunk(line) || header.has(normKey(line))) continue;
    out.push({ startMs: ls, endMs: ls + +lm[2], text: line, words });
  }
  return out;
}

export function hasTimestamps(lrc: string): boolean {
  return /\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/.test(lrc);
}

export interface FinishOptions { s2t: boolean; translation?: string; romaji?: string }

/**
 * 排序、簡轉繁（LYR-5）、補行結束時間（OVL-9）、併入翻譯行。
 * 日文歌詞不做簡轉繁（会→會、残→殘、里→裡 會把日文改壞），但它的中文翻譯照轉。
 */
export function finish(drafts: Draft[], opt: FinishOptions): LyricLine[] {
  const lines = drafts.filter((d) => d.text.trim()).sort((a, b) => a.startMs - b.startMs);
  const ja = looksJapanese(lines.map((d) => d.text));
  const conv = (s: string, words: boolean) => (opt.s2t && !ja && hasCjk(s) ? (words ? toTw(s) : toTwp(s)) : s);
  const convTr = (s: string) => (opt.s2t && hasCjk(s) && !hasKana(s) ? toTwp(s) : s);
  const tr = opt.translation ? parseLrc(opt.translation) : [];
  const ro = opt.romaji ? parseLrc(opt.romaji) : [];
  /** 翻譯 / 拼音行依時間對到歌詞行：取 0.5 秒內最近的一行 */
  const near = (list: Draft[], t: number) => {
    let best: Draft | undefined;
    for (const x of list) if (x.text.trim() && Math.abs(x.startMs - t) <= 500 && (!best || Math.abs(x.startMs - t) < Math.abs(best.startMs - t))) best = x;
    return best;
  };
  return lines.map((d, i): LyricLine => {
    const next = lines[i + 1]?.startMs;
    let words = d.words?.map((w) => ({ ...w, text: conv(w.text, true) }));
    if (words && !words.length) words = undefined;
    const text = words ? words.map((w) => w.text).join('').trim() : conv(d.text, false);
    let endMs = d.endMs;
    if (endMs == null || endMs <= d.startMs) {
      // 行結束 = 下一行開始，但最長不超過「權重 × 0.8 秒」（至少 1.2 秒），避免間奏時一個字拖很久
      const cap = d.startMs + Math.max(1200, weight(text) * 800);
      endMs = Math.min(next ?? cap, cap);
      if (endMs <= d.startMs) endMs = d.startMs + 300;
    }
    const t = near(tr, d.startMs);
    const r = near(ro, d.startMs);
    const line: LyricLine = { startMs: d.startMs, endMs, text };
    if (words) line.words = words;
    if (t) line.translation = convTr(t.text);
    if (r) line.romaji = r.text.replace(/ +/g, ' ').trim();
    return line;
  });
}

/** 快取 / 下載下來的原始歌詞 → LyricDoc */
export function buildDoc(raw: RawLyrics, s2t: boolean): LyricDoc {
  let lines: LyricLine[] = [];
  let plainText: string | undefined;
  if (raw.format === 'yrc') lines = finish(parseYrc(raw.content), { s2t, translation: raw.translation, romaji: raw.romaji });
  else if (raw.format === 'krc') lines = finish(parseKrc(raw.content), { s2t, translation: raw.translation, romaji: raw.romaji });
  else if (raw.format === 'lrc') lines = finish(parseLrc(raw.content), { s2t, translation: raw.translation, romaji: raw.romaji });
  if (raw.format === 'plain' || !lines.length) {
    const text = raw.content.replace(TIME, '').split(/\r?\n/).map((l) => l.trim()).filter((l) => !isJunk(l)).join('\n');
    plainText = s2t && hasCjk(text) && !looksJapanese(text.split('\n')) ? toTwp(text) : text;
  }
  const ja = hasKana(raw.matched) || looksJapanese(lines.length ? lines.map((l) => l.text) : (plainText ?? '').split('\n'));
  return {
    provider: raw.provider,
    providerId: raw.providerId,
    confidence: raw.confidence,
    hasWordTiming: lines.some((l) => l.words?.length),
    lines,
    plainText: lines.length ? undefined : plainText,
    matched: s2t && !ja && hasCjk(raw.matched) ? toTwp(raw.matched) : raw.matched,
  };
}

/** 判斷一段文字是哪種格式 */
export function detectFormat(text: string): RawLyrics['format'] {
  if (/^\[\d+,\d+\]\(/m.test(text)) return 'yrc';
  if (/^\[\d+,\d+\]</m.test(text)) return 'krc';
  if (hasTimestamps(text)) return 'lrc';
  return 'plain';
}
