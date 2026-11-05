// 歌詞擷取流程（SPEC §4.5）：使用者綁定 → 本機快取 → 本機 LRC 資料夾 → 網易雲 / 酷狗 / LRCLIB（依語言決定順序）
import { buildDoc } from './lrc-parser';
import { AUTO_ACCEPT } from './match';
import { hasCjk, hasKana, toCn } from './text';
import type { LyricCandidate, LyricDoc, RawLyrics, TrackInfo } from './types';
import type { Files, Net } from '../providers/deps';
import { fetchNetease, searchNetease } from '../providers/netease';
import { fetchLrclib, searchLrclib } from '../providers/lrclib';
import { fetchKugou, searchKugou } from '../providers/kugou';
import { fetchLocal, searchLocal } from '../providers/local';

export interface Store {
  getLyrics(trackKey: string): Promise<RawLyrics | null>;
  putLyrics(trackKey: string, raw: RawLyrics): Promise<void>;
  deleteLyrics(trackKey: string): Promise<void>;
  getPref(trackKey: string): Promise<{ offsetMs: number; pinned: boolean }>;
  setPref(trackKey: string, p: { offsetMs?: number; pinned?: boolean }): Promise<void>;
}

export interface LyricsOptions {
  s2t: boolean;
  providers: { netease: boolean; kugou: boolean; lrclib: boolean };
  lrcDir: string;
}

export type OnlineProvider = 'netease' | 'kugou' | 'lrclib';

export type LyricStatus = 'found' | 'uncertain' | 'plain' | 'none' | 'error';
export type LyricFrom = 'manual' | 'cache' | 'local' | 'online';

export interface ResolveResult {
  status: LyricStatus;
  from?: LyricFrom;
  doc: LyricDoc | null;
  raw: RawLyrics | null;
  candidates: LyricCandidate[];
  error?: string;
}

const PROVIDER_TIMEOUT = 12_000;   // 一個來源整體（可能含 2~3 次查詢）；單次請求 4 秒由 Rust 控制
const NEGATIVE_TTL = 10 * 60_000;  // 查無歌詞的歌 10 分鐘內不重查（避免網易雲限流）

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} 逾時`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class LyricsService {
  private negative = new Map<string, number>();

  constructor(
    private net: Net,
    private files: Files,
    private store: Store,
    private opts: () => LyricsOptions,
    private log: (m: string) => void = () => {},
  ) {}

  /** 依語言（D2）：有假名（日文）→ 酷狗先；其他中日韓文字 → 網易雲先；純英文 → LRCLIB 先 */
  providerOrder(track: TrackInfo): OnlineProvider[] {
    const o = this.opts();
    const s = track.title + track.artist;
    const order: OnlineProvider[] = hasKana(s) ? ['kugou', 'netease', 'lrclib']
      : hasCjk(s) ? ['netease', 'kugou', 'lrclib']
      : ['lrclib', 'netease', 'kugou'];
    return order.filter((p) => o.providers[p] !== false);
  }

  /** signal：換歌時中止，舊的查詢不要再佔用網易雲的排隊（LYR-9） */
  async resolve(track: TrackInfo, { force = false, signal }: { force?: boolean; signal?: AbortSignal } = {}): Promise<ResolveResult> {
    const key = track.trackKey;
    const s2t = this.opts().s2t;
    if (!force) {
      const cached = await this.store.getLyrics(key).catch(() => null);
      if (cached) {
        const pref = await this.store.getPref(key).catch(() => ({ pinned: false, offsetMs: 0 }));
        const doc = buildDoc(cached, s2t);
        if (pref.pinned) doc.provider = 'manual';
        return { status: statusOf(doc, pref.pinned), from: pref.pinned ? 'manual' : 'cache', doc, raw: cached, candidates: [] };
      }
      const neg = this.negative.get(key);
      if (neg && Date.now() - neg < NEGATIVE_TTL) return { status: 'none', doc: null, raw: null, candidates: [] };
    }

    const all: LyricCandidate[] = [];
    const errors: string[] = [];

    // 本機 LRC 資料夾
    const dir = this.opts().lrcDir;
    if (dir) {
      try {
        const local = await searchLocal(this.files, dir, track);
        all.push(...local);
        if (local[0] && local[0].score >= AUTO_ACCEPT) {
          const raw = await fetchLocal(this.files, local[0]);
          const doc = raw && buildDoc(raw, s2t);
          if (raw && doc?.lines.length) return { status: 'found', from: 'local', doc, raw, candidates: all };
        }
      } catch (e) { this.log(`本機 LRC 失敗：${errText(e)}`); }
    }

    // 線上來源：第一順位分數沒過門檻才查第二順位，兩邊候選合併後取最高
    for (const p of this.providerOrder(track)) {
      const t0 = Date.now();
      try {
        const list = await withTimeout(
          p === 'netease' ? searchNetease(this.net, track, undefined, signal)
            : p === 'kugou' ? searchKugou(this.net, track, undefined, signal)
            : searchLrclib(this.net, track, undefined, signal),
          PROVIDER_TIMEOUT, p,
        );
        all.push(...list);
        this.log(`${p}：${list.length} 筆候選，最高 ${Math.max(0, ...list.map((c) => c.score)).toFixed(2)}，${Date.now() - t0} ms`);
      } catch (e) {
        if (signal?.aborted) throw e;
        errors.push(`${p}：${errText(e)}`);
        this.log(`${p} 搜尋失敗：${errText(e)}`);
      }
      if (bestScore(all) >= AUTO_ACCEPT) break;
    }

    const ranked = rank(all);
    let plain: RawLyrics | null = null;
    let tried = 0;
    for (const c of ranked) {
      if (c.score < 0.5 || tried >= 3) break;
      tried++;
      signal?.throwIfAborted();
      try {
        const raw = await this.fetch(c, signal);
        if (!raw) continue;
        const doc = buildDoc(raw, s2t);
        if (doc.lines.length >= 3) {
          await this.store.putLyrics(key, raw).catch((e) => this.log(`寫入快取失敗：${errText(e)}`));
          return { status: statusOf(doc, false), from: 'online', doc, raw, candidates: ranked };
        }
        if (!plain && doc.plainText) plain = raw;
      } catch (e) {
        if (signal?.aborted) throw e;
        errors.push(`${c.provider}：${errText(e)}`);
        this.log(`取歌詞失敗 ${c.key}：${errText(e)}`);
      }
    }
    if (plain) return { status: 'plain', from: 'online', doc: buildDoc(plain, s2t), raw: plain, candidates: ranked };
    if (!all.length && errors.length) return { status: 'error', doc: null, raw: null, candidates: [], error: errors.join('；') };
    this.negative.set(key, Date.now());
    return { status: 'none', doc: null, raw: null, candidates: ranked };
  }

  async fetch(c: LyricCandidate, signal?: AbortSignal): Promise<RawLyrics | null> {
    switch (c.provider) {
      case 'netease': return fetchNetease(this.net, c, signal);
      case 'kugou': return fetchKugou(this.net, c, signal);
      case 'lrclib': return fetchLrclib(c);
      case 'local': return fetchLocal(this.files, c);
      default: return null;
    }
  }

  /** LYR-7：手動選一個候選 → 綁定這首歌（之後不會被自動結果覆蓋） */
  async choose(track: TrackInfo, c: LyricCandidate): Promise<ResolveResult> {
    const raw = await this.fetch(c);
    if (!raw) throw new Error('這個來源沒有歌詞內容');
    return this.bind(track, { ...raw, confidence: 1 });
  }

  /** LYR-7：拖入 .lrc → 綁定目前歌曲 */
  async bindText(track: TrackInfo, content: string, name: string, format: RawLyrics['format']): Promise<ResolveResult> {
    return this.bind(track, { provider: 'manual', format, content, matched: name, confidence: 1 });
  }

  private async bind(track: TrackInfo, raw: RawLyrics): Promise<ResolveResult> {
    await this.store.putLyrics(track.trackKey, raw);
    await this.store.setPref(track.trackKey, { pinned: true });
    this.negative.delete(track.trackKey);
    const doc = buildDoc(raw, this.opts().s2t);
    doc.provider = 'manual';
    return { status: statusOf(doc, true), from: 'manual', doc, raw, candidates: [] };
  }

  /** 取消綁定並清掉快取 */
  async forget(track: TrackInfo): Promise<void> {
    await this.store.deleteLyrics(track.trackKey);
    await this.store.setPref(track.trackKey, { pinned: false });
    this.negative.delete(track.trackKey);
  }

  /** LYR-7：手動輸入關鍵字搜尋，只回傳候選讓使用者挑 */
  async searchManual(track: TrackInfo, query: string, signal?: AbortSignal): Promise<LyricCandidate[]> {
    const out: LyricCandidate[] = [];
    const o = this.opts();
    const jobs: Promise<void>[] = [];
    if (o.providers.netease) jobs.push(searchNetease(this.net, track, [toCn(query)], signal).then((l) => { out.push(...l); }, (e) => this.log(`netease 手動搜尋失敗：${errText(e)}`)));
    if (o.providers.kugou !== false) jobs.push(searchKugou(this.net, track, [query, ...(hasCjk(query) && toCn(query) !== query ? [toCn(query)] : [])], signal).then((l) => { out.push(...l); }, (e) => this.log(`kugou 手動搜尋失敗：${errText(e)}`)));
    if (o.providers.lrclib) jobs.push(searchLrclib(this.net, track, query, signal).then((l) => { out.push(...l); }, (e) => this.log(`lrclib 手動搜尋失敗：${errText(e)}`)));
    await Promise.all(jobs);
    return rank(out);
  }
}

function statusOf(doc: LyricDoc, pinned: boolean): LyricStatus {
  if (!doc.lines.length) return doc.plainText ? 'plain' : 'none';
  return pinned || doc.confidence >= AUTO_ACCEPT ? 'found' : 'uncertain';
}

function bestScore(list: LyricCandidate[]): number {
  return Math.max(0, ...list.filter((c) => c.provider !== 'lrclib' || c.inline?.synced).map((c) => c.score));
}

/** 分數高的在前；LRCLIB 只有純文字的往後排 */
export function rank(list: LyricCandidate[]): LyricCandidate[] {
  const seen = new Set<string>();
  return list
    .filter((c) => (seen.has(c.key) ? false : (seen.add(c.key), true)))
    .sort((a, b) => {
      const pa = a.provider === 'lrclib' && !a.inline?.synced ? 0.2 : 0;
      const pb = b.provider === 'lrclib' && !b.inline?.synced ? 0.2 : 0;
      return b.score - pb - (a.score - pa);
    });
}
