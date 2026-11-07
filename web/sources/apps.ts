// 認得的播放器名稱表（不依賴其他模組，控制面板也直接用，避免載入簡繁字典）
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

export const isKnown = (aumid: string) => APPS.some(([re]) => re.test(aumid));

export function appName(aumid: string): string {
  return APPS.find(([re]) => re.test(aumid))?.[1] ?? aumid.replace(/\.exe$/i, '').split(/[\\!]/).pop() ?? aumid;
}
