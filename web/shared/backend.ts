// 呼叫 Rust 指令的薄包裝；型別對應 src-tauri/src/*.rs
import { invoke } from '@tauri-apps/api/core';
import type { Files, KugouItem, LrclibItem, Net, NeteaseLyric, NeteaseSong } from '../providers/deps';
import type { Store } from '../core/lyrics';
import type { RawLyrics } from '../core/types';

export interface Style {
  font: 'pixel' | 'normal';
  lines: 1 | 2;
  unsung: string;
  sungFrom: string;
  sungTo: string;
  outline: boolean;
  outlineColor: string;
  shadow: boolean;
  opacity: number;
}

export interface Settings {
  globalOffsetMs: number;
  s2t: boolean;
  showTranslation: boolean;
  showRomaji: boolean;
  providers: { netease: boolean; kugou: boolean; lrclib: boolean };
  lrcDir: string;
  pinnedAumid: string | null;
  style: Style;
  hotkeys: Record<HotkeyAction, string>;
}

export type LinkName = 'site' | 'github' | 'donate';
export type HotkeyAction = 'toggle' | 'edit' | 'earlier' | 'later' | 'earlierFine' | 'laterFine' | 'resetOffset' | 'research';
export interface HotkeyStatus { action: HotkeyAction; accel: string; ok: boolean; error?: string | null }

export interface SmtcSession {
  aumid: string;
  title: string;
  artist: string;
  album: string;
  status: 'playing' | 'paused' | 'stopped' | 'other';
  positionMs: number;
  endMs: number;
  lastUpdatedUnixMs: number;
  rate: number;
  isCurrent: boolean;
}

export interface UiState { edit: boolean; visible: boolean; scale: number }

export const api = {
  settingsGet: () => invoke<Settings>('settings_get'),
  settingsSet: (patch: DeepPartial<Settings>) => invoke<Settings>('settings_set', { patch }),
  settingsDefaults: () => invoke<Settings>('settings_defaults'),
  hotkeysStatus: () => invoke<HotkeyStatus[]>('hotkeys_status'),
  hotkeysSuspend: (suspend: boolean) => invoke<void>('hotkeys_suspend', { suspend }),
  autostartGet: () => invoke<boolean>('autostart_get'),
  autostartSet: (on: boolean) => invoke<boolean>('autostart_set', { on }),
  uiState: () => invoke<UiState>('get_ui_state'),
  setEditMode: (on?: boolean) => invoke<boolean>('set_edit_mode', { on }),
  setOverlayVisible: (visible?: boolean) => invoke<boolean>('set_overlay_visible', { visible }),
  overlayPreset: (place: 'top' | 'center' | 'bottom') => invoke<void>('overlay_preset', { placeAt: place }),
  overlayScale: (scale: number) => invoke<void>('overlay_scale', { scale }),
  showPanel: () => invoke<void>('open_panel'),
  lrcRead: (path: string) => invoke<string>('lrc_read', { path }),
  openDataDir: () => invoke<void>('open_data_dir'),
  dataDirPath: () => invoke<string>('data_dir_path'),
  openLink: (which: LinkName) => invoke<void>('open_link', { which }),
  linksEnabled: () => invoke<LinkName[]>('links_enabled'),
  openDoc: (which: 'license' | 'notices') => invoke<void>('open_doc', { which }),
  log: (msg: string) => invoke<void>('log_line', { msg }).catch(() => {}),
};

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** 換歌時 +1；Rust 會丟掉還在排隊、屬於舊世代的網易雲請求 */
let netGen = 0;
export function bumpNetGen(): void {
  netGen++;
  invoke('net_set_gen', { gen: netGen }).catch(() => {});
}

export const net: Net = {
  neteaseSearch: (keywords) => invoke<NeteaseSong[]>('netease_search', { keywords, gen: netGen }),
  neteaseLyric: (id) => invoke<NeteaseLyric>('netease_lyric', { id, gen: netGen }),
  lrclibGet: (q) => invoke<LrclibItem | null>('lrclib_get', { track: q.track, artist: q.artist, album: q.album ?? null, durationS: q.durationS ?? null }),
  lrclibSearch: (q) => invoke<LrclibItem[]>('lrclib_search', { q }),
  kugouSearch: (keyword, durationMs) => invoke<KugouItem[]>('kugou_search', { keyword, durationMs: durationMs ?? null }),
  kugouLyric: (id, accesskey) => invoke<string>('kugou_lyric', { id, accesskey }),
};

export const files: Files = {
  list: (dir) => invoke<{ name: string; path: string }[]>('lrc_list', { dir }),
  read: (path) => invoke<string>('lrc_read', { path }),
};

interface Row {
  trackKey: string; provider: string; providerId?: string | null; format: string; rawContent: string;
  translation?: string | null; romaji?: string | null; confidence?: number | null; matched?: string | null;
}

export const store: Store = {
  async getLyrics(trackKey) {
    const r = await invoke<Row | null>('db_lyrics_get', { trackKey });
    if (!r) return null;
    return {
      provider: r.provider as RawLyrics['provider'], providerId: r.providerId ?? undefined, format: r.format as RawLyrics['format'],
      content: r.rawContent, translation: r.translation ?? undefined, romaji: r.romaji ?? undefined, matched: r.matched ?? '', confidence: r.confidence ?? 0,
    };
  },
  putLyrics: (trackKey, raw) => invoke('db_lyrics_put', {
    row: {
      trackKey, provider: raw.provider, providerId: raw.providerId ?? null, format: raw.format, rawContent: raw.content,
      translation: raw.translation ?? null, romaji: raw.romaji ?? null, confidence: raw.confidence, matched: raw.matched,
    },
  }),
  deleteLyrics: (trackKey) => invoke('db_lyrics_delete', { trackKey }),
  getPref: (trackKey) => invoke<{ offsetMs: number; pinned: boolean }>('db_pref_get', { trackKey }),
  setPref: (trackKey, p) => invoke('db_pref_set', { trackKey, offsetMs: p.offsetMs ?? null, pinned: p.pinned ?? null }),
};
