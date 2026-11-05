// 資料模型（SPEC §8）
export type SourceKind = 'smtc' | 'youtube' | 'local-file';

export interface TrackInfo {
  source: SourceKind;
  appId?: string;          // SMTC AUMID
  appName: string;         // 顯示用：YT Music / Spotify / Chrome …
  rawTitle: string;
  rawArtist: string;
  album?: string;
  durationMs?: number;
  title: string;           // 正規化後（去掉括號標記）
  artist: string;
  trackKey: string;        // NORM-6
  /** 搜尋用的歌名變體（NORM-3：只留中文 / 只留英文） */
  titleVariants: string[];
  /** 搜尋與比對用的歌手（NORM-4：拆開合唱者；第一個是主唱） */
  artists: string[];
  /** 原曲標題本身就有的版本標記（Live / Remix …），比對時不扣分（LYR-2） */
  versionTags: string[];
}

export type PlayStatus = 'playing' | 'paused' | 'stopped';

export interface ClockSnapshot {
  positionMs: number;
  capturedAt: number;      // performance.now() 時間軸
  rate: number;
  status: PlayStatus;
}

export interface LyricWord { text: string; startMs: number; endMs: number; }
export interface LyricLine { startMs: number; endMs: number; text: string; words?: LyricWord[]; translation?: string; romaji?: string; }

export type ProviderId = 'netease' | 'kugou' | 'lrclib' | 'local' | 'manual';

export interface LyricDoc {
  provider: ProviderId;
  providerId?: string;
  confidence: number;
  hasWordTiming: boolean;
  lines: LyricLine[];
  /** 只有純文字歌詞時（LYR-3） */
  plainText?: string;
  matched?: string;        // 對到的「歌手 - 歌名」
}

/** 未解析的歌詞內容（存進快取的形式） */
export interface RawLyrics {
  provider: ProviderId;
  providerId?: string;
  format: 'lrc' | 'yrc' | 'krc' | 'plain';
  content: string;
  translation?: string;
  /** 羅馬拼音（LRC 時間標記，逐行） */
  romaji?: string;
  matched: string;
  confidence: number;
}

export interface LyricCandidate {
  key: string;             // provider:id，唯一
  provider: ProviderId;
  id: string;
  title: string;
  artist: string;
  album?: string;
  durationMs?: number;
  score: number;
  /** LRCLIB 的搜尋結果直接帶歌詞 */
  inline?: { synced?: string | null; plain?: string | null };
  /** 酷狗下載歌詞要用的金鑰 */
  accesskey?: string;
  /** 本機檔案路徑 */
  path?: string;
  /** 面板顯示用：只有純文字、沒有時間軸 */
  plainOnly?: boolean;
}
