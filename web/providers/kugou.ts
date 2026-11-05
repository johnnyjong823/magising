// 酷狗（日文歌覆蓋率高、KRC 逐字；華語要用簡體查）。直接用「歌手 - 歌名」+ 時長搜歌詞，沒有網易雲那種 1.5 秒限制
import { AUTO_ACCEPT, scoreCandidate } from '../core/match';
import { hasCjk, toCn } from '../core/text';
import type { LyricCandidate, RawLyrics, TrackInfo } from '../core/types';
import type { KugouItem, Net } from './deps';

/** 查詢關鍵字：原文「歌手 - 歌名」（日文歌要用原文）→ 簡體（華語歌）→ 其他歌名變體；最多 3 次 */
export function kugouQueries(track: TrackInfo): string[] {
  const a0 = track.artists[0] ?? '';
  const q = (t: string) => (a0 ? `${a0} - ${t}` : t);
  const qs = [q(track.title)];
  if (hasCjk(qs[0])) qs.push(toCn(qs[0]));
  for (const t of track.titleVariants) qs.push(q(t));
  return [...new Set(qs.filter(Boolean))].slice(0, 3);
}

function toCandidate(track: TrackInfo, x: KugouItem): LyricCandidate {
  return {
    key: `kugou:${x.id}`, provider: 'kugou', id: String(x.id), accesskey: x.accesskey, title: x.song, artist: x.singer, durationMs: x.durationMs || undefined,
    score: scoreCandidate(track, { title: x.song, artist: x.singer, durationMs: x.durationMs || undefined }),
  };
}

export async function searchKugou(net: Net, track: TrackInfo, queries = kugouQueries(track), signal?: AbortSignal): Promise<LyricCandidate[]> {
  const out = new Map<string, LyricCandidate>();
  let lastErr: unknown = null;
  for (const q of queries) {
    signal?.throwIfAborted();
    let list: KugouItem[];
    try { list = await net.kugouSearch(q, track.durationMs); } catch (e) { lastErr = e; continue; }
    for (const x of list) if (x.id && x.accesskey && !out.has(`kugou:${x.id}`)) out.set(`kugou:${x.id}`, toCandidate(track, x));
    if (Math.max(0, ...[...out.values()].map((c) => c.score)) >= AUTO_ACCEPT) break;
  }
  if (!out.size && lastErr) throw lastErr;
  return [...out.values()];
}

export async function fetchKugou(net: Net, c: LyricCandidate, signal?: AbortSignal): Promise<RawLyrics | null> {
  signal?.throwIfAborted();
  if (!c.accesskey) return null;
  const krc = await net.kugouLyric(c.id, c.accesskey);
  if (!/^\[\d+,\d+\]</m.test(krc)) return null;
  const { content, translation, romaji } = splitKrc(krc);
  return { provider: 'kugou', providerId: c.id, format: 'krc', content, translation, romaji, matched: `${c.artist} - ${c.title}`, confidence: c.score };
}

/**
 * KRC 的 [language:base64] 標籤是 JSON：type 1 = 翻譯、type 0 = 羅馬拼音，每一項對應一行歌詞（照 KRC 行的順序）。
 * 翻譯與拼音都轉成 LRC 時間標記，交給 finish() 依時間併入；language 標籤本身很長，從內容拿掉再存快取。
 * 羅馬拼音是一個字一段（'shi zu '、'mu '…），接起來後把多餘空白收掉。
 */
export function splitKrc(krc: string): { content: string; translation?: string; romaji?: string } {
  const m = krc.match(/^\[language:([^\]]*)\]\s*$/m);
  const content = krc.replace(/^\[language:[^\]]*\]\s*\r?\n?/m, '');
  if (!m) return { content };
  try {
    const bin = atob(m[1].trim());
    const json = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0))));
    const parts = (json.content as { type: number; lyricContent: string[][] }[] | undefined) ?? [];
    const starts = [...content.matchAll(/^\[(\d+),\d+\]/gm)].map((x) => +x[1]);
    const toLrc = (type: number) => {
      const p = parts.find((x) => x.type === type);
      if (!p) return undefined;
      const lrc = starts.map((ms, i) => {
        const text = (p.lyricContent[i] ?? []).join('').replace(/\s+/g, ' ').trim();
        return text ? `${lrcTime(ms)}${text}` : '';
      }).filter(Boolean).join('\n');
      return lrc || undefined;
    };
    return { content, translation: toLrc(1), romaji: toLrc(0) };
  } catch {
    return { content };
  }
}

function lrcTime(ms: number): string {
  const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000), cs = Math.floor((ms % 1000) / 10);
  return `[${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}]`;
}
