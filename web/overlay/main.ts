// 字幕視窗 = 核心：偵測歌曲 → 找歌詞 → 時鐘 → 繪製。控制面板關掉時這裡照常運作
import { emitTo, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { PlaybackClock } from '../core/clock';
import { LyricsService, type ResolveResult } from '../core/lyrics';
import { buildDoc, detectFormat } from '../core/lrc-parser';
import { looksLikeAd } from '../core/normalize';
import { hasCjk, hasKana, toTwp } from '../core/text';
import type { LyricCandidate, LyricDoc, RawLyrics, TrackInfo } from '../core/types';
import { api, bumpNetGen, files, net, store, type Settings, type SmtcSession } from '../shared/backend';
import { EV, type CoreCmd, type CoreTrackState, type LyricUiStatus } from '../shared/protocol';
import { SmtcSource } from '../sources/smtc';
import { KtvRenderer } from './render';

const $ = (id: string) => document.getElementById(id)!;
const log = (m: string) => { console.log(m); api.log('[core] ' + m); };
addEventListener('error', (e) => log('error: ' + e.message));
addEventListener('unhandledrejection', (e) => log('reject: ' + (e.reason?.message ?? e.reason)));

let settings!: Settings;   // 啟動時讀取；之前收到的事件會先略過
const clock = new PlaybackClock();
const renderer = new KtvRenderer($('slotA'), $('slotB'), $('dots'), $('trans'), $('roma'));
const lyrics = new LyricsService(net, files, store, () => settings, log);

// ---------- 狀態 ----------
let track: TrackInfo | null = null;
let thumb: string | null = null;
let doc: LyricDoc | null = null;
let raw: RawLyrics | null = null;
let status: LyricUiStatus = 'idle';
let from: ResolveResult['from'];
let message = '';
let candidates: LyricCandidate[] = [];
let candidatesBusy = false;
let offsetMs = 0;            // 本首（PRC-1），正數 = 歌詞提早
let gen = 0;                 // 換歌就 +1，舊的查詢結果丟掉（LYR-9：同一首歌同時只發一個請求）
let editing = false;
let preview = false;
let pausedAt = 0;
let lineIndex = -1;

const source = new SmtcSource(onTrack, (snap) => {
  clock.update(snap);
  pausedAt = snap.status === 'playing' ? 0 : pausedAt || performance.now();
});

// ---------- 換歌 ----------
let abort = new AbortController();   // 換歌就中止舊的查詢（LYR-9：同一首歌同時只發一個請求）
let resolving = false;

async function onTrack(t: TrackInfo | null) {
  const my = ++gen;
  abort.abort();
  abort = new AbortController();
  bumpNetGen();
  track = t;
  thumb = null;
  setDoc(null, null);
  candidates = [];
  candidatesBusy = false;
  resolving = false;
  offsetMs = 0;
  message = '';
  from = undefined;
  log(t ? `換歌：${t.appName} | ${t.rawArtist} - ${t.rawTitle} → ${t.trackKey}` : '沒有播放中的歌');
  if (!t) { status = 'idle'; pushTrack(); return; }
  if (looksLikeAd(t.rawTitle, t.rawArtist)) { status = 'ad'; pushTrack(); return; }   // SRC-A5
  status = 'searching';
  pushTrack();
  store.getPref(t.trackKey).then((p) => { if (my === gen) { offsetMs = p.offsetMs; pushTrack(); } }).catch(() => {});
  toast(`♪ ${t.artist ? t.artist + ' - ' : ''}${t.title}`, 5000);
  // Chrome 常常先給歌名、再補歌手和時長：等一下再查，避免同一首歌查兩次
  await new Promise((r) => setTimeout(r, 400));
  if (my !== gen) return;
  await runResolve(my, false);
}

async function runResolve(my: number, force: boolean) {
  if (!track || my !== gen || resolving) return;
  const t = track;
  const signal = abort.signal;
  const prev = { doc, raw, status, from };
  resolving = true;
  status = 'searching';
  candidatesBusy = true;
  pushTrack();
  let r: ResolveResult;
  const t0 = performance.now();
  try {
    r = await lyrics.resolve(t, { force, signal });
  } catch (e) {
    r = { status: 'error', doc: null, raw: null, candidates: [], error: String(e) };
  }
  if (my !== gen || signal.aborted) { log(`已換歌，丟掉「${t.title}」的查詢結果`); return; }
  log(`歌詞：${t.title} → ${r.status}${r.from ? '（' + r.from + '）' : ''} ${r.doc?.matched ?? r.error ?? ''}，${Math.round(performance.now() - t0)} ms`);
  resolving = false;
  candidatesBusy = false;
  if (force && prev.doc?.lines.length && (r.status === 'none' || r.status === 'error')) {
    // 重新搜尋失敗（例如沒網路）→ 保留畫面上原本可用的歌詞
    status = prev.status; from = prev.from; message = r.error ?? '';
    if (r.candidates.length) candidates = r.candidates;
    pushTrack();
    toast(r.status === 'error' ? '重新搜尋失敗，先保留原本的歌詞' : '沒有找到其他歌詞，先保留原本的', 6000, true);
    return;
  }
  applyResult(r);
  if (r.status === 'none' || r.status === 'error') {
    const short = (t.durationMs ?? 0) > 0 && (t.durationMs ?? 0) < 40_000;
    if (short) { status = 'ad'; pushTrack(); return; }           // SRC-A5：短又查無歌詞 → 視為廣告，安靜略過
    toast(r.status === 'error' ? '歌詞查詢失敗，請檢查網路' : '找不到這首歌的同步歌詞', 10_000, true);
  } else if (r.status === 'plain') {
    toast('只找到純文字歌詞（沒有時間軸），可在控制面板查看', 10_000, true);
  } else if (r.status === 'uncertain') {
    toast(`♪ 歌詞可能不準：${r.doc?.matched ?? ''}（可在控制面板換一份）`, 8000, true);
  }
}

function applyResult(r: ResolveResult) {
  setDoc(r.doc, r.raw);
  status = r.status;
  from = r.from;
  message = r.error ?? '';
  if (r.candidates.length) candidates = r.candidates;
  pushTrack();
}

function setDoc(d: LyricDoc | null, r: RawLyrics | null) {
  doc = d;
  raw = r;
  renderer.setLines(d?.lines ?? []);
  renderer.fitFont(settings?.style.font ?? 'pixel');
}

// ---------- 偏移（SYNC-4、PRC-1） ----------
function setOffset(v: number, say = true) {
  if (!track) return;
  offsetMs = Math.round(v);
  store.setPref(track.trackKey, { offsetMs }).catch((e) => log('存偏移失敗：' + e));
  if (say) {
    const s = offsetMs / 1000;
    toast(offsetMs === 0 ? '歌詞時間已歸零' : `本首歌詞${s > 0 ? '提早' : '延後'} ${Math.abs(s).toFixed(2)} 秒`, 2500);
  }
  pushTrack();
}

const tw = (x: string) => (settings?.s2t && hasCjk(x) ? toTwp(x) : x);
const displayTime = () => clock.now() + (settings?.globalOffsetMs ?? 0) + offsetMs;

// ---------- 推給控制面板 ----------
function snapshot(): CoreTrackState {
  return {
    track, thumb,
    lyric: {
      status, from, message,
      provider: doc?.provider, matched: doc?.matched, confidence: doc?.confidence, hasWordTiming: doc?.hasWordTiming,
    },
    lines: (doc?.lines ?? []).map((l) => ({ startMs: l.startMs, text: l.text, translation: l.translation, romaji: l.romaji })),
    plainText: doc?.plainText,
    // 歌詞內容不用傳；名稱轉繁體給面板顯示（面板不載入 OpenCC）；日文歌名（有假名）不轉，免得改壞漢字
    candidates: candidates.map((c) => {
      const ja = hasKana(c.title + c.artist);
      return {
        ...c, inline: undefined, plainOnly: c.provider === 'lrclib' && !c.inline?.synced,
        title: ja ? c.title : tw(c.title), artist: ja ? c.artist : tw(c.artist),
      };
    }),
    candidatesBusy,
    offsetMs,
  };
}
let pushQueued = false;
function pushTrack() {
  if (pushQueued) return;
  pushQueued = true;
  queueMicrotask(() => { pushQueued = false; emitTo('panel', EV.track, snapshot()).catch(() => {}); });
}
setInterval(() => {
  emitTo('panel', EV.tick, {
    positionMs: clock.now(), durationMs: track?.durationMs ?? 0, playing: clock.playing, status: clock.status, lineIndex,
  }).catch(() => {});
}, 250);

// ---------- 面板指令 ----------
listen<CoreCmd>(EV.cmd, async ({ payload: c }) => {
  const t = track;
  const my = gen;
  switch (c.type) {
    case 'hello': pushTrack(); break;
    case 'research':
      if (!t || resolving) return;
      await store.setPref(t.trackKey, { pinned: false }).catch(() => {});
      toast('重新搜尋歌詞中…', 3000);
      await runResolve(my, true);
      break;
    case 'search': {
      if (!t) return;
      candidatesBusy = true; pushTrack();
      let found: LyricCandidate[] = [];
      try { found = await lyrics.searchManual(t, c.query, abort.signal); } catch (e) { log('手動搜尋失敗：' + e); }
      if (my !== gen) return;               // 已經換歌：結果是上一首的，丟掉
      candidates = found;
      candidatesBusy = resolving; pushTrack();
      break;
    }
    case 'choose': {
      const cand = candidates.find((x) => x.key === c.key);
      if (!t || !cand) return;
      try {
        const r = await lyrics.choose(t, cand);
        if (my !== gen) return;
        applyResult({ ...r, candidates });
        toast(`♪ 已換成：${r.doc?.matched ?? ''}`, 4000);
      } catch (e) { toast('這份歌詞載入失敗：' + e, 6000, true); }
      break;
    }
    case 'bind': {
      if (!t) return;
      const fmt = detectFormat(c.content);
      const r = await lyrics.bindText(t, c.content, c.name, fmt);
      if (my !== gen) return;
      applyResult({ ...r, candidates });
      toast(r.doc?.lines.length ? `♪ 已綁定 ${c.name}` : '這個檔案沒有時間軸', 4000, !r.doc?.lines.length);
      break;
    }
    case 'forget':
      if (!t) return;
      await lyrics.forget(t);
      await runResolve(my, true);
      break;
    case 'offset': setOffset(offsetMs + c.deltaMs); break;
    case 'offset-set': setOffset(c.offsetMs); break;
    case 'line-now': {
      // 「這行現在正在唱」→ 算出偏移
      const L = doc?.lines[c.index];
      if (L) setOffset(L.startMs - (clock.now() + (settings?.globalOffsetMs ?? 0)));
      break;
    }
    case 'preview': preview = c.on; renderer.setSample(editing || preview); break;
  }
});

// ---------- 快捷鍵（Rust 轉過來的） ----------
listen<string>('hotkey', ({ payload: a }) => {
  if (a === 'earlier') setOffset(offsetMs + 250);
  else if (a === 'later') setOffset(offsetMs - 250);
  else if (a === 'earlierFine') setOffset(offsetMs + 50);
  else if (a === 'laterFine') setOffset(offsetMs - 50);
  else if (a === 'resetOffset') setOffset(0);
  else if (a === 'research' && track && !resolving) { toast('重新搜尋歌詞中…', 3000); store.setPref(track.trackKey, { pinned: false }).finally(() => runResolve(gen, true)); }
});

// ---------- SMTC ----------
listen<SmtcSession[]>('smtc', ({ payload }) => { if (settings) source.handle(payload, settings.pinnedAumid); });
listen<{ aumid: string; title: string; artist: string; dataUrl: string | null }>('smtc-thumb', ({ payload: p }) => {
  if (track && track.appId === p.aumid && track.rawTitle === p.title && track.rawArtist === p.artist) { thumb = p.dataUrl; pushTrack(); }
  else pendingThumb = p;
});
let pendingThumb: { aumid: string; title: string; artist: string; dataUrl: string | null } | null = null;
setInterval(() => {   // 封面有時比歌名先到
  const p = pendingThumb;
  if (p && track && track.appId === p.aumid && track.rawTitle === p.title && track.rawArtist === p.artist) { thumb = p.dataUrl; pendingThumb = null; pushTrack(); }
}, 1000);

// ---------- 設定 ----------
function applySettings(s: Settings) {
  const prev = settings;
  settings = s;
  renderer.applyStyle(s.style, s.showTranslation, s.showRomaji);
  if (prev && prev.s2t !== s.s2t && raw) {   // 簡轉繁開關 → 重新解析
    const d = buildDoc(raw, s.s2t);
    d.provider = doc?.provider ?? d.provider;
    setDoc(d, raw);
    pushTrack();
  }
}
listen<Settings>('settings', ({ payload }) => applySettings(payload));
addEventListener('resize', () => renderer.fitFont(settings?.style.font ?? 'pixel'));

// ---------- 提示（UI-7） ----------
let toastTimer = 0;
function toast(msg: string, ms = 5000, warn = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('warn', warn);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), ms);
}

// ---------- 移動字幕模式（OVL-3） ----------
function setEditing(on: boolean) {
  editing = on;
  document.body.classList.toggle('edit', on);
  renderer.setSample(editing || preview);
}
listen<boolean>('edit-mode', ({ payload }) => setEditing(payload));
$('edit').addEventListener('mousedown', (e) => {
  const el = e.target as HTMLElement;
  if (e.button !== 0 || el.closest('button') || el.id === 'grip') return;
  getCurrentWindow().startDragging();
});
$('grip').addEventListener('mousedown', (e) => { e.preventDefault(); getCurrentWindow().startResizeDragging('SouthEast'); });
$('done').onclick = () => api.setEditMode(false);
document.querySelectorAll<HTMLElement>('[data-place]').forEach((b) => {
  b.onclick = () => api.overlayPreset(b.dataset.place as 'top' | 'center' | 'bottom');
});

// ---------- 主迴圈（OVL-5 淡出、OVL-12 降頻） ----------
function shouldShow(): boolean {
  if (editing || preview) return true;
  if (!renderer.hasLines || status === 'ad') return false;
  if (clock.status === 'stopped') return false;
  if (!clock.playing && pausedAt && performance.now() - pausedAt > 5000) return false;   // 暫停超過 5 秒
  return true;
}
function loop() {
  const show = shouldShow();
  document.body.classList.toggle('faded', !show);
  lineIndex = renderer.frame(displayTime());
  if (show && clock.playing && renderer.hasLines) requestAnimationFrame(loop);
  else setTimeout(loop, 500);
}

// ---------- 啟動 ----------
(async () => {
  applySettings(await api.settingsGet());
  setEditing((await api.uiState()).edit);
  await document.fonts.load('48px Cubic11').catch(() => {});
  renderer.fitFont(settings.style.font);
  loop();
  log('overlay ready');
})();
