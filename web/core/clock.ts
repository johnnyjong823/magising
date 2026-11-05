// 播放時鐘（SPEC §4.4 SYNC-1~3）
// 估計位置 = reportedPosition + (now − capturedAt) × rate（播放中）；暫停時 = reportedPosition
// 新回報值與估計值差 > 1.5 s → 視為跳轉立即對齊；否則 300 ms 內平滑校正
import type { ClockSnapshot, PlayStatus } from './types';

export const JUMP_MS = 1500;
export const SMOOTH_MS = 300;

export class PlaybackClock {
  private pos = 0;
  private at = 0;
  private rate = 1;
  status: PlayStatus = 'stopped';
  private corr = 0;
  private corrAt = 0;

  /** 回傳 true 表示是跳轉（或第一次 / 狀態改變） */
  update(s: ClockSnapshot, now = performance.now()): boolean {
    const wasPlaying = this.status === 'playing';
    const before = this.now(now);
    this.pos = s.positionMs;
    this.at = s.capturedAt;
    this.rate = s.rate > 0 ? s.rate : 1;
    this.status = s.status;
    const after = this.raw(now);
    const diff = before - after;
    if (!wasPlaying || s.status !== 'playing' || Math.abs(diff) > JUMP_MS) {
      this.corr = 0;
      return !wasPlaying || Math.abs(diff) > JUMP_MS;
    }
    this.corr = diff;
    this.corrAt = now;
    return false;
  }

  private raw(now: number): number {
    return this.status === 'playing' ? this.pos + (now - this.at) * this.rate : this.pos;
  }

  private correction(now: number): number {
    if (!this.corr) return 0;
    const k = 1 - (now - this.corrAt) / SMOOTH_MS;
    if (k <= 0) { this.corr = 0; return 0; }
    return this.corr * k;
  }

  now(now = performance.now()): number {
    return Math.max(0, this.raw(now) + this.correction(now));
  }

  get playing(): boolean {
    return this.status === 'playing';
  }

  reset(): void {
    this.pos = 0; this.at = 0; this.rate = 1; this.status = 'stopped'; this.corr = 0;
  }
}
