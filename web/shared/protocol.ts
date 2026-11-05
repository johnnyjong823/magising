// 字幕視窗（核心）↔ 控制面板 之間的事件格式
import type { LyricCandidate, TrackInfo } from '../core/types';
import type { LyricFrom } from '../core/lyrics';

export type LyricUiStatus = 'idle' | 'searching' | 'found' | 'uncertain' | 'plain' | 'none' | 'error' | 'ad';

/** 換歌、歌詞改變時才送（'core-track'） */
export interface CoreTrackState {
  track: TrackInfo | null;
  thumb: string | null;
  lyric: {
    status: LyricUiStatus;
    from?: LyricFrom;
    provider?: string;
    matched?: string;
    confidence?: number;
    hasWordTiming?: boolean;
    message?: string;
  };
  lines: { startMs: number; text: string; translation?: string; romaji?: string }[];
  plainText?: string;
  candidates: LyricCandidate[];
  candidatesBusy: boolean;
  offsetMs: number;
}

/** 每 250 ms 送一次（'core-tick'） */
export interface CoreTick {
  positionMs: number;
  durationMs: number;
  playing: boolean;
  status: string;
  lineIndex: number;
}

/** 面板 → 核心（'core-cmd'） */
export type CoreCmd =
  | { type: 'hello' }
  | { type: 'research' }
  | { type: 'search'; query: string }
  | { type: 'choose'; key: string }
  | { type: 'bind'; content: string; name: string }
  | { type: 'forget' }
  | { type: 'offset'; deltaMs: number }
  | { type: 'offset-set'; offsetMs: number }
  | { type: 'line-now'; index: number }
  | { type: 'preview'; on: boolean };

export const EV = {
  track: 'core-track',
  tick: 'core-tick',
  cmd: 'core-cmd',
  toast: 'core-toast',
} as const;
