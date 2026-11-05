// KTV 字幕繪製（OVL-6~13、SPEC §9）
// 換行時才重建 DOM 並量一次每個字的位置；每幀只改一個 CSS 變數 --px
import { lineIndexAt, lineTokens, progressPx, type Measured } from '../core/timing';
import type { LyricLine } from '../core/types';
import type { Style } from '../shared/backend';

const SAMPLE: LyricLine[] = [
  { startMs: 0, endMs: 1, text: '♪ 這是字幕預覽 ♪' },
  { startMs: 1, endMs: 2, text: '拖到你喜歡的位置' },
];

export class KtvRenderer {
  private lines: LyricLine[] = [];
  private shown = -2;
  private sample = false;
  private curEl: HTMLElement | null = null;
  private measured: Measured[] = [];
  private oneLine = false;
  private showTrans = false;
  private showRoma = false;

  constructor(
    private A: HTMLElement,
    private B: HTMLElement,
    private dots: HTMLElement,
    private trans: HTMLElement,
    private roma: HTMLElement,
  ) {}

  setLines(lines: LyricLine[]) { this.lines = lines; this.shown = -2; }
  setSample(on: boolean) { if (this.sample !== on) { this.sample = on; this.shown = -2; } }
  get hasLines() { return this.lines.length > 0; }

  applyStyle(s: Style, showTrans: boolean, showRoma: boolean) {
    const b = document.body;
    b.classList.toggle('font-normal', s.font === 'normal');
    b.classList.toggle('outline', s.outline);
    b.classList.toggle('shadow', s.shadow);
    b.classList.toggle('one-line', s.lines === 1);
    b.style.setProperty('--unsung', s.unsung);
    b.style.setProperty('--sung-from', s.sungFrom);
    b.style.setProperty('--sung-to', s.sungTo);
    b.style.setProperty('--outline', s.outlineColor);
    b.style.setProperty('--opacity', String(Math.min(1, Math.max(0.2, s.opacity))));
    this.oneLine = s.lines === 1;
    this.showTrans = showTrans;
    this.showRoma = showRoma;
    this.fitFont(s.font);
    this.shown = -2;
  }

  /** 字的大小跟著視窗高度；像素字型對齊 12 px 的倍數（UI-2）。下方有翻譯 / 拼音時主字縮小讓位置 */
  fitFont(font: Style['font']) {
    const withTrans = this.showTrans && this.lines.some((l) => l.translation);
    const withRoma = this.showRoma && this.lines.some((l) => l.romaji);
    const subs = +withTrans + +withRoma;
    document.body.classList.toggle('with-trans', subs > 0);   // 下方有一行小字
    document.body.classList.toggle('with-both', subs === 2);  // 下方有兩行小字（拼音在上、翻譯在下）
    const raw = innerHeight * (subs === 2 ? 0.18 : subs ? 0.2 : 0.23) * (this.oneLine ? 1.15 : 1);
    const fs = font === 'pixel' ? Math.max(24, Math.floor(raw / 12) * 12) : Math.max(22, Math.round(raw));
    document.body.style.setProperty('--fs', fs + 'px');
    this.shown = -2;
  }

  /** t = 顯示時間（已含偏移）。回傳目前行號 */
  frame(t: number): number {
    const L = this.lines.length ? this.lines : this.sample ? SAMPLE : [];
    const real = L === this.lines;
    const i = real ? lineIndexAt(L, t) : 0;
    if (i !== this.shown) this.layout(L, i, real);
    if (this.curEl) {
      const px = real ? progressPx(this.measured, t) : (this.measured[0]?.x ?? 0) + 0.45 * this.lineWidth();
      this.curEl.style.setProperty('--px', px.toFixed(1) + 'px');
    }
    this.countdown(L, i, t, real);
    return i;
  }

  private lineWidth(): number {
    const m = this.measured;
    return m.length ? m[m.length - 1].x + m[m.length - 1].w - m[0].x : 0;
  }

  private layout(L: LyricLine[], i: number, real: boolean) {
    this.shown = i;
    this.A.replaceChildren();
    this.B.replaceChildren();
    this.curEl = null;
    this.measured = [];
    this.trans.textContent = '';
    this.roma.textContent = '';
    if (!L.length) return;
    const cur = Math.max(i, 0);
    const started = !real || i >= 0;
    if (this.oneLine) {
      this.A.append(this.lineEl(L[cur], started ? 'cur' : 'next'));
    } else {
      const [curSlot, otherSlot] = cur % 2 === 0 ? [this.A, this.B] : [this.B, this.A];
      curSlot.append(this.lineEl(L[cur], started ? 'cur' : 'next'));
      if (L[cur + 1]) otherSlot.append(this.lineEl(L[cur + 1], 'next'));
    }
    if (this.showTrans && started && L[cur].translation) this.trans.textContent = L[cur].translation!;
    if (this.showRoma && started && L[cur].romaji) this.roma.textContent = L[cur].romaji!;
    // 量字的位置（只在換行時做一次），然後長句縮小（OVL-13）
    for (const el of [...this.A.children, ...this.B.children] as HTMLElement[]) {
      const slot = el.parentElement!;
      const s = Math.min(1, slot.clientWidth / Math.max(1, el.offsetWidth));
      el.style.transform = s < 1 ? `scale(${s})` : '';
    }
    const curEl = (this.A.querySelector('.line.cur') ?? this.B.querySelector('.line.cur')) as HTMLElement | null;
    if (curEl) {
      this.curEl = curEl;
      const toks = lineTokens(L[cur]);
      const spans = curEl.querySelectorAll<HTMLElement>('.ink > i');
      this.measured = toks.map((k, n) => ({ x: spans[n]?.offsetLeft ?? 0, w: spans[n]?.offsetWidth ?? 0, startMs: k.startMs, endMs: k.endMs }));
    } else {
      // 前奏：第一句先預告，不填色
      const first = (this.A.firstElementChild ?? this.B.firstElementChild) as HTMLElement | null;
      first?.style.setProperty('--px', '0px');
    }
  }

  private lineEl(line: LyricLine, cls: string): HTMLElement {
    const d = document.createElement('div');
    d.className = 'line ' + cls;
    const ink = document.createElement('span');
    ink.className = 'ink';
    // 每個填色單位一個 <i>，用來量位置
    for (const k of lineTokens(line)) {
      const s = document.createElement('i');
      s.style.fontStyle = 'normal';
      s.textContent = k.text;
      ink.append(s);
    }
    const base = document.createElement('span');
    base.className = 'base';
    const fill = document.createElement('span');
    fill.className = 'fill';
    base.textContent = fill.textContent = ink.textContent;
    d.append(ink, base, fill);
    return d;
  }

  /** OVL-10：前奏與超過 5 秒的間奏，在下一句前 3 秒顯示倒數 */
  private countdown(L: LyricLine[], i: number, t: number, real: boolean) {
    let text = '';
    const n = i + 1;
    if (real && L[n]) {
      const gapStart = i >= 0 ? L[i].endMs : 0;
      const left = L[n].startMs - t;
      if ((i < 0 || L[n].startMs - gapStart > 5000) && left > 0 && left <= 3000) text = '■'.repeat(Math.ceil(left / 1000));
    }
    if (this.dots.textContent !== text) this.dots.textContent = text;
    if (!text) return;
    const slot = this.oneLine || n % 2 === 0 ? this.A : this.B;
    const top = slot.offsetTop - this.dots.offsetHeight - 2;   // 在那一行的正上方，不壓到字
    this.dots.style.top = Math.max(2, top) + 'px';
    if (slot === this.B && !this.oneLine) { this.dots.style.left = ''; this.dots.style.right = '4%'; }
    else { this.dots.style.right = ''; this.dots.style.left = this.oneLine ? '50%' : '4%'; }
  }
}
