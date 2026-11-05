// 本機 LRC 資料夾：檔名「歌手 - 歌名.lrc」或「歌名.lrc」模糊比對
import { scoreCandidate } from '../core/match';
import { detectFormat } from '../core/lrc-parser';
import type { LyricCandidate, RawLyrics, TrackInfo } from '../core/types';
import type { Files } from './deps';

let listCache: { dir: string; at: number; files: { name: string; path: string }[] } | null = null;

export async function searchLocal(files: Files, dir: string, track: TrackInfo): Promise<LyricCandidate[]> {
  if (!dir) return [];
  if (!listCache || listCache.dir !== dir || Date.now() - listCache.at > 30_000) {
    listCache = { dir, at: Date.now(), files: await files.list(dir) };
  }
  const out: LyricCandidate[] = [];
  for (const f of listCache.files) {
    const m = f.name.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    const meta = m ? { artist: m[1], title: m[2] } : { artist: '', title: f.name };
    // 檔名沒有歌手時，不要因為「歌手不符」被壓到 0.5
    const t = meta.artist ? track : { ...track, artists: [], artist: '' };
    let score = scoreCandidate(t, meta);
    // 有些人存成「歌名 - 歌手」
    if (m) score = Math.max(score, scoreCandidate(track, { artist: m[2], title: m[1] }));
    if (score >= 0.5) out.push({ key: `local:${f.path}`, provider: 'local', id: f.path, path: f.path, title: meta.title, artist: meta.artist, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 10);
}

export async function fetchLocal(files: Files, c: LyricCandidate): Promise<RawLyrics | null> {
  const content = await files.read(c.path!);
  return { provider: 'local', providerId: c.path, format: detectFormat(content), content, matched: c.path!.split(/[\\/]/).pop()!, confidence: c.score };
}
