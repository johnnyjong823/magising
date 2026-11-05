// 網易雲音樂（華語覆蓋率高，約 70% 有逐字時間軸）。限流處理在 Rust（LYR-9）
import { AUTO_ACCEPT, scoreCandidate } from '../core/match';
import { hasTimestamps } from '../core/lrc-parser';
import { hasCjk, toCn } from '../core/text';
import type { LyricCandidate, RawLyrics, TrackInfo } from '../core/types';
import type { Net } from './deps';

// 已有可自動採用的候選就不再查（網易雲每次請求要間隔 1.5 秒，多查一次就慢 1.5 秒）
const GOOD = AUTO_ACCEPT;

/** 查詢關鍵字：簡體「歌名 歌手」→ 簡體「歌名」→ 原文（NORM-7）；最多 3 次（每次至少間隔 1.5 秒） */
export function neteaseQueries(track: TrackInfo): string[] {
  const a0 = track.artists[0] ?? '';
  const qs: string[] = [];
  for (const t of track.titleVariants) qs.push(toCn(`${t} ${a0}`.trim()));
  qs.push(toCn(track.title));
  const orig = `${track.title} ${a0}`.trim();
  if (hasCjk(orig) && toCn(orig) !== orig) qs.push(orig);
  return [...new Set(qs.filter(Boolean))].slice(0, 3);
}

export async function searchNetease(net: Net, track: TrackInfo, queries = neteaseQueries(track), signal?: AbortSignal): Promise<LyricCandidate[]> {
  const out = new Map<string, LyricCandidate>();
  let lastErr: unknown = null;
  for (const q of queries) {
    signal?.throwIfAborted();
    let list;
    try { list = await net.neteaseSearch(q); } catch (e) { lastErr = e; break; }
    for (const s of list) {
      const key = `netease:${s.id}`;
      if (out.has(key)) continue;
      const artist = s.artists.join('、');
      out.set(key, {
        key, provider: 'netease', id: String(s.id), title: s.name, artist, album: s.album, durationMs: s.durationMs,
        score: scoreCandidate(track, { title: s.name, artist, durationMs: s.durationMs }),
      });
    }
    if (Math.max(0, ...[...out.values()].map((c) => c.score)) >= GOOD) break;
  }
  if (!out.size && lastErr) throw lastErr;
  return [...out.values()];
}

export async function fetchNetease(net: Net, c: LyricCandidate, signal?: AbortSignal): Promise<RawLyrics | null> {
  signal?.throwIfAborted();
  const ly = await net.neteaseLyric(+c.id);
  const matched = `${c.artist} - ${c.title}`;
  const base = { provider: 'netease' as const, providerId: c.id, matched, confidence: c.score, translation: ly.tlyric || undefined, romaji: ly.romalrc || undefined };
  if (ly.yrc && /^\[\d+,\d+\]\(/m.test(ly.yrc)) return { ...base, format: 'yrc', content: ly.yrc };
  if (ly.lrc && hasTimestamps(ly.lrc)) return { ...base, format: 'lrc', content: ly.lrc };
  if (ly.lrc?.trim()) return { ...base, format: 'plain', content: ly.lrc };
  return null;
}
