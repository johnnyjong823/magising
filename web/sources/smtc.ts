// SMTC 偵測模式（SRC-A3：Session 選擇；SYNC-2：時間戳不合理時改用收到的時間）
import { buildTrack } from '../core/normalize';
import type { ClockSnapshot, TrackInfo } from '../core/types';
import type { SmtcSession } from '../shared/backend';

/**
 * 認得的播放器（比對 AUMID，由上往下第一個符合的為準）。改這裡也要改 src-tauri/src/smtc.rs 的 APPS。
 * 瀏覽器分頁（YouTube、Spotify 網頁版、KKBOX 網頁版、SoundCloud…）會以瀏覽器的名義出現。
 */
const APPS: [RegExp, string][] = [
  [/_crx_cinhimbnkk/i, 'YT Music'],           // YT Music PWA：Chrome._crx_cinhimbnkk…
  [/spotify/i, 'Spotify'],
  [/applemusic|itunes/i, 'Apple Music'],
  [/amazon\s*music/i, 'Amazon Music'],
  [/kkbox/i, 'KKBOX'],
  [/tidal/i, 'TIDAL'],
  [/deezer/i, 'Deezer'],
  [/zunemusic/i, '媒體播放器'],
  [/foobar2000/i, 'foobar2000'],
  [/musicbee/i, 'MusicBee'],
  [/aimp/i, 'AIMP'],
  [/cloudmusic/i, '網易雲音樂'],
  [/qqmusic/i, 'QQ 音樂'],
  [/kugou/i, '酷狗音樂'],
  [/_crx_/i, '網頁 App'],                     // 其他 Chrome / Edge PWA
  [/chrome/i, 'Chrome'],
  [/msedge/i, 'Edge'],
  [/firefox|308046B0AF4A39CB/i, 'Firefox'],   // Firefox 的 AUMID 是安裝路徑的雜湊，預設路徑是這串
  [/opera/i, 'Opera'],
  [/brave/i, 'Brave'],
  [/vivaldi/i, 'Vivaldi'],
];

const isKnown = (aumid: string) => APPS.some(([re]) => re.test(aumid));

export function appName(aumid: string): string {
  return APPS.find(([re]) => re.test(aumid))?.[1] ?? aumid.replace(/\.exe$/i, '').split(/[\\!]/).pop() ?? aumid;
}

/**
 * ① 手動釘選 ② 正在播的 YT Music PWA ③ 正在播且是認得的播放器（Spotify、Apple Music、KKBOX、瀏覽器…）
 * ④ YT Music（暫停中）⑤ 系統目前的 Session ⑥ 第一個
 */
export function pickSession(list: SmtcSession[], pinned: string | null): SmtcSession | null {
  const live = list.filter((s) => s.title);
  if (!live.length) return null;
  const playing = (s: SmtcSession) => s.status === 'playing';
  const ytm = (s: SmtcSession) => appName(s.aumid) === 'YT Music';
  return (pinned ? live.find((s) => s.aumid === pinned) : undefined)
    ?? live.find((s) => ytm(s) && playing(s))
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
