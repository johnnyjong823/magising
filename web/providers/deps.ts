// Provider 需要的外部能力。App 裡由 Rust 指令實作（web/shared/backend.ts），測試時可換成 Node 版
export interface NeteaseSong { id: number; name: string; artists: string[]; durationMs: number; album?: string }
export interface NeteaseLyric { lrc: string; yrc: string; tlyric: string; romalrc?: string }
export interface KugouItem { id: string; accesskey: string; singer: string; song: string; durationMs?: number }
export interface LrclibItem {
  id: number;
  trackName: string;
  artistName: string;
  albumName?: string;
  duration?: number;          // 秒
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

export interface Net {
  neteaseSearch(keywords: string): Promise<NeteaseSong[]>;
  neteaseLyric(id: number): Promise<NeteaseLyric>;
  lrclibGet(q: { track: string; artist: string; album?: string; durationS?: number }): Promise<LrclibItem | null>;
  lrclibSearch(q: string): Promise<LrclibItem[]>;
  kugouSearch(keyword: string, durationMs?: number): Promise<KugouItem[]>;
  /** 已解碼的 KRC 文字 */
  kugouLyric(id: string, accesskey: string): Promise<string>;
}

export interface Files {
  list(dir: string): Promise<{ name: string; path: string }[]>;
  read(path: string): Promise<string>;
}
