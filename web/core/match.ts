// 候選歌詞評分（LYR-1、LYR-2）
import { cleanTitle, splitArtists, versionTagsOf } from './normalize';
import { similarity } from './text';
import type { TrackInfo } from './types';

export const AUTO_ACCEPT = 0.75;

export interface CandidateMeta { title: string; artist: string; durationMs?: number }

/**
 * 歌名相似度 50% + 歌手相似度 30% + 時長差 20%（≤ 3 秒滿分、> 10 秒零分）。
 * 已知歌手但候選歌手不符 → 最高 0.5，不會自動採用。
 * 候選是 Live / Remix / Cover… 而原曲不是 → 扣 0.3。
 */
export function scoreCandidate(track: TrackInfo, c: CandidateMeta): number {
  const ct = cleanTitle(c.title).title;
  let ts = 0;
  for (const t of track.titleVariants) ts = Math.max(ts, similarity(ct, t), similarity(c.title, t));
  if (ts < 0.5) return Math.round(ts * 0.5 * 1000) / 1000;

  const known = track.artists.length > 0;
  let as = 0.5;
  if (known) {
    const candArtists = [c.artist, ...splitArtists(c.artist)];
    as = 0;
    for (const q of [track.artist, ...track.artists]) for (const a of candArtists) as = Math.max(as, similarity(a, q));
  }

  let ds = 0.5;
  if (track.durationMs && c.durationMs && track.durationMs > 0 && c.durationMs > 0) {
    const d = Math.abs(track.durationMs - c.durationMs) / 1000;
    ds = d <= 3 ? 1 : d >= 10 ? 0 : 1 - (d - 3) / 7;
  }

  let s = ts * 0.5 + as * 0.3 + ds * 0.2;
  if (known && as < 0.5) s = Math.min(s, 0.5);
  const extra = versionTagsOf(c.title).filter((v) => !track.versionTags.includes(v) && v !== '合唱版');
  if (extra.length) s -= 0.3;
  return Math.max(0, Math.round(s * 1000) / 1000);
}
