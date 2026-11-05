// LRCLIB（lrclib.net，免費開放 API；英文歌優先）
import { scoreCandidate } from '../core/match';
import { hasCjk, toCn } from '../core/text';
import type { LyricCandidate, RawLyrics, TrackInfo } from '../core/types';
import type { LrclibItem, Net } from './deps';

const GOOD = 0.85;

function toCandidate(track: TrackInfo, x: LrclibItem): LyricCandidate {
  const durationMs = x.duration ? x.duration * 1000 : undefined;
  return {
    key: `lrclib:${x.id}`, provider: 'lrclib', id: String(x.id), title: x.trackName, artist: x.artistName, album: x.albumName, durationMs,
    score: scoreCandidate(track, { title: x.trackName, artist: x.artistName, durationMs }),
    inline: { synced: x.syncedLyrics, plain: x.plainLyrics },
  };
}

export async function searchLrclib(net: Net, track: TrackInfo, query?: string, signal?: AbortSignal): Promise<LyricCandidate[]> {
  const out = new Map<string, LyricCandidate>();
  const add = (x: LrclibItem) => { if (!x.instrumental && (x.syncedLyrics || x.plainLyrics)) out.set(`lrclib:${x.id}`, toCandidate(track, x)); };
  const best = () => Math.max(0, ...[...out.values()].filter((c) => c.inline?.synced).map((c) => c.score));
  const a0 = track.artists[0] ?? '';

  if (!query && a0 && track.durationMs) {
    // 精確查詢（歌名 + 歌手 + 時長）
    const j = await net.lrclibGet({ track: track.title, artist: a0, album: track.album, durationS: Math.round(track.durationMs / 1000) });
    if (j) add(j);
    if (best() >= GOOD) return [...out.values()];
  }
  const qs: string[] = [];
  if (query) qs.push(query);
  else for (const t of track.titleVariants) {
    qs.push(`${t} ${a0}`.trim());
    if (hasCjk(t + a0)) qs.push(toCn(`${t} ${a0}`.trim()));    // NORM-7
  }
  for (const q of [...new Set(qs)].slice(0, 4)) {
    signal?.throwIfAborted();
    for (const x of await net.lrclibSearch(q)) add(x);
    if (best() >= GOOD) break;
  }
  return [...out.values()];
}

export async function fetchLrclib(c: LyricCandidate): Promise<RawLyrics | null> {
  const matched = `${c.artist} - ${c.title}`;
  const base = { provider: 'lrclib' as const, providerId: c.id, matched, confidence: c.score };
  if (c.inline?.synced) return { ...base, format: 'lrc', content: c.inline.synced };
  if (c.inline?.plain) return { ...base, format: 'plain', content: c.inline.plain };
  return null;
}
