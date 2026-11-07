// SMTC 偵測模式（SRC-A3：Session 選擇；SYNC-2：時間戳不合理時改用收到的時間）
import { buildTrack } from '../core/normalize';
import type { ClockSnapshot, TrackInfo } from '../core/types';
import type { SmtcSession } from '../shared/backend';
import { appName, isKnown } from './apps';

export { appName };

/** 有正常歌曲長度（30 秒～20 分鐘）。直播沒有長度（0）或長得不像一首歌 */
export const songLike = (s: SmtcSession) => s.endMs >= 30_000 && s.endMs <= 20 * 60_000;

/**
 * ① 手動釘選 ② 正在播的 YT Music PWA ③ 正在播、認得、而且長度像一首歌（避開瀏覽器裡的直播）
 * ④ 正在播且是認得的播放器（Spotify、Apple Music、KKBOX、瀏覽器…）⑤ YT Music（暫停中）⑥ 系統目前的 Session ⑦ 第一個
 */
export function pickSession(list: SmtcSession[], pinned: string | null): SmtcSession | null {
  const live = list.filter((s) => s.title);
  if (!live.length) return null;
  const playing = (s: SmtcSession) => s.status === 'playing';
  const ytm = (s: SmtcSession) => appName(s.aumid) === 'YT Music';
  return (pinned ? live.find((s) => s.aumid === pinned) : undefined)
    ?? live.find((s) => ytm(s) && playing(s))
    ?? live.find((s) => playing(s) && isKnown(s.aumid) && songLike(s))
    ?? live.find((s) => playing(s) && isKnown(s.aumid))
    ?? live.find(ytm)
    ?? live.find((s) => s.isCurrent)
    ?? live[0];
}

export class SmtcSource {
  private songSig = '';
  private clockSig = '';
  track: TrackInfo | null = null;
  current: SmtcSession | null = null;

  constructor(
    private onTrack: (t: TrackInfo | null) => void,
    private onClock: (c: ClockSnapshot) => void,
  ) {}

  handle(list: SmtcSession[], pinned: string | null): void {
    const s = pickSession(list, pinned);
    this.current = s;
    if (!s) {
      if (this.songSig) { this.songSig = ''; this.clockSig = ''; this.track = null; this.onTrack(null); }
      return;
    }
    const songSig = `${s.aumid}|${s.artist}|${s.title}`;
    if (songSig !== this.songSig) {
      this.songSig = songSig;
      this.clockSig = '';
      this.track = buildTrack({
        source: 'smtc', appId: s.aumid, appName: appName(s.aumid),
        rawTitle: s.title, rawArtist: s.artist, album: s.album || undefined, durationMs: s.endMs > 0 ? s.endMs : undefined,
      });
      this.onTrack(this.track);
    } else if (this.track && s.endMs > 0 && this.track.durationMs !== s.endMs) {
      this.track.durationMs = s.endMs;   // 時長有時比歌名晚到
    }
    const clockSig = `${s.positionMs}|${s.lastUpdatedUnixMs}|${s.status}|${s.rate}`;
    if (clockSig === this.clockSig) return;
    this.clockSig = clockSig;
    this.onClock(snapshotOf(s));
  }
}

export function snapshotOf(s: SmtcSession, nowWall = Date.now(), nowPerf = performance.now()): ClockSnapshot {
  const age = nowWall - s.lastUpdatedUnixMs;
  // SYNC-2：未來時間或過舊（> 15 分鐘）→ 用現在當作回報時間
  const capturedAt = age < -1000 || age > 15 * 60_000 ? nowPerf : nowPerf - age;
  const status = s.status === 'playing' ? 'playing' : s.status === 'paused' ? 'paused' : 'stopped';
  return { positionMs: s.positionMs, capturedAt, rate: s.rate || 1, status };
}
