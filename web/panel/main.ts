// 控制面板（§4.9）。只負責顯示和送指令；狀態都在字幕視窗的核心
import { getVersion } from '@tauri-apps/api/app';
import { emitTo, listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open } from '@tauri-apps/plugin-dialog';
import { hydrateIcons, iconSvg, setIcon } from '../shared/icons';
import { api, type HotkeyAction, type HotkeyStatus, type Settings, type SmtcSession, type UiState, type UpdateStatus } from '../shared/backend';
import { appName } from '../sources/apps';
import { EV, type CoreCmd, type CoreTick, type CoreTrackState } from '../shared/protocol';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const cmd = (c: CoreCmd) => emitTo('overlay', EV.cmd, c);
const fmt = (ms: number) => { ms = Math.max(0, ms || 0); return `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`; };
const secs = (ms: number) => { const s = ms / 1000; return (s > 0 ? '+' : s < 0 ? '−' : '±') + Math.abs(s).toFixed(2) + ' 秒'; };
addEventListener('error', (e) => api.log('[panel] error: ' + e.message));
addEventListener('unhandledrejection', (e) => api.log('[panel] reject: ' + (e.reason?.message ?? e.reason)));

hydrateIcons();

let tipTimer = 0;
function tip(msg: string, ms = 3000) {
  $('tip').textContent = msg;
  $('tip').classList.add('show');
  clearTimeout(tipTimer);
  tipTimer = window.setTimeout(() => $('tip').classList.remove('show'), ms);
}

// ================= 分頁 =================
let page = 'now';
document.querySelectorAll<HTMLElement>('.tab').forEach((t) => {
  t.onclick = () => {
    page = t.dataset.tab!;
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === t));
    document.querySelectorAll<HTMLElement>('main[data-page]').forEach((m) => { m.hidden = m.dataset.page !== page; });
    cmd({ type: 'preview', on: page === 'style' });     // 字幕樣式頁：字幕顯示預覽字
  };
});
addEventListener('beforeunload', () => { cmd({ type: 'preview', on: false }); });

// ================= 字幕：移動 / 顯示 / 大小 / 位置 =================
let ui: UiState = { edit: false, visible: true, scale: 1 };
function paintUi() {
  const mv = $('moveBtn');
  mv.classList.toggle('active', ui.edit);
  mv.classList.toggle('primary', !ui.edit);
  mv.lastElementChild!.textContent = ui.edit ? '移好了，完成' : '移動字幕';
  setIcon(mv.firstElementChild as HTMLElement, ui.edit ? 'check' : 'move');
  $('banner').classList.toggle('show', ui.edit);
  const sb = $('showBtn');
  sb.lastElementChild!.textContent = ui.visible ? '隱藏字幕' : '顯示字幕';
  setIcon(sb.firstElementChild as HTMLElement, ui.visible ? 'eyeoff' : 'eye');
  sb.classList.toggle('off', !ui.visible);
  const level = Math.round((ui.scale - 0.6) / 0.1);                 // OVL-14：60%~160% 共 11 格
  $('blocks').innerHTML = Array.from({ length: 11 }, (_, i) => `<i data-lv="${i}" class="${i <= level ? 'on' : ''}" title="${60 + i * 10}%"></i>`).join('');
  $('blocks').querySelectorAll<HTMLElement>('i').forEach((b) => { b.onclick = () => setScale(0.6 + +b.dataset.lv! * 0.1); });
}
async function setScale(s: number) {
  s = Math.min(1.6, Math.max(0.6, Math.round(s * 10) / 10));
  await api.overlayScale(s);
  ui.scale = s;
  paintUi();
}
$('moveBtn').onclick = async () => {
  ui.edit = await api.setEditMode(!ui.edit);
  paintUi();
  if (ui.edit) tip('字幕已解鎖，用滑鼠拖它；擺好按「完成」');
};
$('bannerDone').onclick = () => api.setEditMode(false);
$('showBtn').onclick = async () => { ui.visible = await api.setOverlayVisible(!ui.visible); paintUi(); };
document.querySelectorAll<HTMLElement>('[data-place]').forEach((b) => {
  b.onclick = () => { api.overlayPreset(b.dataset.place as 'top'); tip('字幕已移到' + b.textContent!.trim()); };
});
$('sizeDown').onclick = () => setScale(ui.scale - 0.1);
$('sizeUp').onclick = () => setScale(ui.scale + 0.1);
listen<boolean>('edit-mode', async ({ payload }) => { ui = await api.uiState(); ui.edit = payload; paintUi(); });
listen<boolean>('overlay-visible', ({ payload }) => { ui.visible = payload; paintUi(); });

// ================= 偏移 =================
$('offEarlier').onclick = () => cmd({ type: 'offset', deltaMs: 250 });
$('offLater').onclick = () => cmd({ type: 'offset', deltaMs: -250 });
$('offVal').onclick = () => cmd({ type: 'offset-set', offsetMs: 0 });

// ================= 現在播放（核心推送） =================
let st: CoreTrackState | null = null;
let tick: CoreTick | null = null;
let candOpen = false;

listen<CoreTrackState>(EV.track, ({ payload }) => { st = payload; paintTrack(); });
listen<CoreTick>(EV.tick, ({ payload }) => { tick = payload; paintTick(); });

function paintTrack() {
  const s = st, t = s?.track;
  $('nowEmpty').hidden = !!t;
  $('nowFull').hidden = !t;
  $('offVal').textContent = secs(s?.offsetMs ?? 0);
  if (t) {
    const b = $('srcBadge');
    b.textContent = t.appName || '—';
    b.className = 'badge' + (t.appName === 'YT Music' ? ' ytm' : '');
    $('song').textContent = t.title || t.rawTitle;
    $('song').title = t.rawTitle;
    $('artist').textContent = t.artist || '（不明歌手）';
    const img = $<HTMLImageElement>('cover');
    if (s!.thumb) { img.src = s!.thumb; img.hidden = false; $('coverPh').hidden = true; }
    else { img.hidden = true; $('coverPh').hidden = false; }
  }
  paintLyricState();
  paintCands();
  paintLyricList();
  paintTick();
  paintSources();
}

// ================= 播放來源（同時有好幾個在播時切換；和系統匣「播放來源」同一個設定） =================
let sessions: SmtcSession[] = [];
let srcKey = '';
listen<SmtcSession[]>('smtc', ({ payload }) => { sessions = payload.filter((s) => s.title); paintSources(); });

function paintSources() {
  if (!settings) return;
  const pinned = settings.pinnedAumid;
  const using = st?.track?.appId ?? '';
  const items = sessions.map((s) => ({ aumid: s.aumid, name: appName(s.aumid), title: s.title, playing: s.status === 'playing' }));
  if (pinned && !items.some((i) => i.aumid === pinned)) items.push({ aumid: pinned, name: appName(pinned), title: '目前沒有播放', playing: false });
  // 只有一個來源、也沒有釘選時不用選，整列藏起來
  const show = items.length >= 2 || !!pinned;
  const key = JSON.stringify([show, pinned, using, items]);
  if (key === srcKey) return;
  srcKey = key;
  $('srcRow').hidden = !show;
  if (!show) return;
  $('srcList').innerHTML =
    `<button class="btn sm${pinned ? '' : ' active'}" data-src="">自動選擇</button>` +
    items.map((i) => `<button class="btn sm${pinned === i.aumid ? ' active' : ''}" data-src="${esc(i.aumid)}" title="${esc(i.name + ' — ' + i.title)}">
      <span class="dot${i.playing ? ' on' : ''}"></span>${esc(i.name)}<span class="t muted">${esc(i.title)}</span>${using === i.aumid ? '<span class="use">字幕</span>' : ''}</button>`).join('');
  $('srcList').querySelectorAll<HTMLElement>('[data-src]').forEach((b) => {
    b.onclick = async () => {
      const aumid = b.dataset.src || null;
      await save({ pinnedAumid: aumid });
      tip(aumid ? `字幕改跟著「${appName(aumid)}」` : '改回自動選擇（YT Music 優先，其次是正在播的歌）');
    };
  });
}

function paintLyricState() {
  const s = st, L = s?.lyric;
  const ok = (m: string) => `<span class="ok">${iconSvg('ok')} ${m}</span>`;
  const warn = (m: string) => `<span class="warn">${iconSvg('warn')} ${m}</span>`;
  const muted = (m: string) => `<span class="muted">${m}</span>`;
  const src = { netease: '網易雲', kugou: '酷狗', lrclib: 'LRCLIB', local: '本機 LRC', manual: '手動綁定' }[L?.provider ?? ''] ?? L?.provider ?? '';
  const detail = L?.matched ? muted(`· ${esc(src)}${L.hasWordTiming ? '（逐字）' : '（逐行）'} · ${esc(L.matched)}`) : '';
  const fromText = L?.from === 'cache' ? muted('· 來自快取') : '';
  let html = muted('還沒有歌曲');
  if (s?.track) {
    html = {
      idle: muted('等待中'),
      searching: `<span class="muted">${iconSvg('search')} 搜尋歌詞中…</span>`,
      found: ok('已找到歌詞') + detail + fromText,
      uncertain: warn(`可能不準（相似度 ${Math.round((L?.confidence ?? 0) * 100)}%）`) + detail + muted('· 不對的話按「換一份歌詞」'),
      plain: warn('只找到純文字歌詞，沒有時間軸，字幕無法跟著跑') + detail,
      none: warn('找不到這首歌的同步歌詞') + muted('· 可以按「換一份歌詞」自己搜尋，或拖入 .lrc 檔'),
      error: `<span class="bad">${iconSvg('warn')} 歌詞查詢失敗，請檢查網路</span>` + (L?.message ? muted('· ' + esc(L.message)) : ''),
      ad: muted('廣告或很短的片段，字幕先隱藏'),
    }[L?.status ?? 'idle'];
  }
  const el = $('lyricState');
  if (el.dataset.k !== html) { el.innerHTML = html; el.dataset.k = html; }
  const has = !!s?.track;
  for (const id of ['research', 'showCands', 'pickLrc']) $<HTMLButtonElement>(id).disabled = !has;
  $('forget').hidden = L?.from !== 'manual';
  $('showCands').classList.toggle('active', candOpen);
  if (L?.status === 'none' || L?.status === 'uncertain') { if (!candOpen && has && s!.candidates.length) openCands(true); }
}

function openCands(on: boolean) {
  candOpen = on;
  $('candBox').hidden = !on;
  $('showCands').classList.toggle('active', on);
  if (on && st?.track && !$<HTMLInputElement>('query').value) $<HTMLInputElement>('query').value = `${st.track.title} ${st.track.artists[0] ?? ''}`.trim();
  if (on && st?.track && !st.candidates.length && !st.candidatesBusy) cmd({ type: 'search', query: $<HTMLInputElement>('query').value });
}
$('showCands').onclick = () => openCands(!candOpen);
$('research').onclick = () => { cmd({ type: 'research' }); tip('重新搜尋中…'); };
$('forget').onclick = () => { cmd({ type: 'forget' }); tip('已取消手動綁定，重新自動搜尋'); };
$('searchForm').onsubmit = (e) => {
  e.preventDefault();
  const q = $<HTMLInputElement>('query').value.trim();
  if (q) cmd({ type: 'search', query: q });
};

function paintCands() {
  const box = $('cands');
  const s = st;
  if (!s) { box.innerHTML = ''; return; }
  if (s.candidatesBusy && !s.candidates.length) { box.innerHTML = '<div class="muted small">搜尋中…</div>'; return; }
  if (!s.candidates.length) { box.innerHTML = '<div class="muted small">沒有候選。換個關鍵字試試看（例如只打歌名）。</div>'; return; }
  const prov = { netease: '網易雲', kugou: '酷狗', lrclib: 'LRCLIB', local: '本機', manual: '手動' } as Record<string, string>;
  const curId = s.lyric.provider !== 'manual' ? `${s.lyric.provider}:` : '';
  box.innerHTML = s.candidates.slice(0, 30).map((c) => {
    const sc = Math.round(c.score * 100);
    const cls = c.score >= 0.75 ? 'hi' : c.score >= 0.5 ? 'mid' : 'lo';
    const cur = curId && st?.lyric.matched === `${c.artist} - ${c.title}` ? ' current' : '';
    return `<div class="cand${cur}">
      <div class="t">${esc(c.title)} <span class="muted">— ${esc(c.artist)}</span></div>
      <div class="m">${prov[c.provider] ?? c.provider}${c.plainOnly ? ' · <span class="warn">純文字</span>' : ''}${c.durationMs ? ' · ' + fmt(c.durationMs) : ''} · <span class="score ${cls}">${sc}%</span></div>
      <button class="btn sm" data-key="${esc(c.key)}">${cur ? '使用中' : '用這個'}</button>
    </div>`;
  }).join('') + (s.candidatesBusy ? '<div class="muted small">還在搜尋…</div>' : '');
  box.querySelectorAll<HTMLElement>('[data-key]').forEach((b) => {
    b.onclick = () => { cmd({ type: 'choose', key: b.dataset.key! }); tip('載入歌詞中…'); };
  });
}

let listKey = '';
function paintLyricList() {
  const s = st;
  const el = $('lyricList');
  const roma = !!settings?.showRomaji;
  const key = s ? `${s.track?.trackKey}|${s.lyric.matched}|${s.lines.length}|${s.plainText?.length ?? 0}|${roma}` : '';
  if (key === listKey) return;
  listKey = key;
  $('lyricListHint').hidden = !s?.lines.length;
  if (s?.lines.length) {
    el.innerHTML = s.lines.map((l, i) =>
      `<button class="ln" data-i="${i}"><span class="ts">${fmt(l.startMs)}</span>${esc(l.text)}${roma && l.romaji ? `<small>${esc(l.romaji)}</small>` : ''}${l.translation ? `<small>${esc(l.translation)}</small>` : ''}</button>`).join('');
    el.querySelectorAll<HTMLElement>('.ln').forEach((b) => {
      b.onclick = () => { cmd({ type: 'line-now', index: +b.dataset.i! }); tip('已對時：這行就是現在唱的'); };
    });
  } else if (s?.plainText) {
    el.innerHTML = `<pre>${esc(s.plainText)}</pre>`;
  } else el.innerHTML = '';
  curLine = -2;
}

let curLine = -2;
function paintTick() {
  const s = st, k = tick;
  const has = !!s?.track;
  $('led').classList.toggle('on', !!(has && k?.playing));
  $('chipText').textContent = !has ? '等待播放' : `${k?.playing ? '播放中' : '已暫停'} · ${s!.track!.appName}`;
  $('nowCard').classList.toggle('playing', !!k?.playing);
  if (!has || !k) return;
  const dur = k.durationMs || s!.track!.durationMs || 0;
  $('barFill').style.width = (dur ? Math.min(100, (k.positionMs / dur) * 100) : 0) + '%';
  $('time').textContent = `${fmt(k.positionMs)} / ${fmt(dur)}`;
  if (k.lineIndex !== curLine) {
    const list = $('lyricList');
    list.querySelector('.ln.cur')?.classList.remove('cur');
    const el = list.querySelector<HTMLElement>(`.ln[data-i="${k.lineIndex}"]`);
    if (el) {
      el.classList.add('cur');
      // 只在清單內捲動，不動整個頁面
      const top = el.offsetTop - list.offsetTop - list.clientHeight / 2 + el.clientHeight / 2;
      list.scrollTo({ top, behavior: curLine < -1 ? 'auto' : 'smooth' });
    }
    curLine = k.lineIndex;
  }
}

// ================= .lrc 檔：選擇 / 拖入（LYR-7） =================
async function bindFile(path: string) {
  if (!st?.track) { tip('要先有正在播放的歌，才能綁定歌詞'); return; }
  if (!/\.lrc$/i.test(path)) { tip('只能用 .lrc 歌詞檔'); return; }
  try {
    const content = await api.lrcRead(path);
    cmd({ type: 'bind', content, name: path.split(/[\\/]/).pop()! });
  } catch (e) { tip('讀取失敗：' + e, 5000); }
}
$('pickLrc').onclick = async () => {
  const p = await open({ multiple: false, directory: false, filters: [{ name: 'LRC 歌詞', extensions: ['lrc'] }] });
  if (typeof p === 'string') bindFile(p);
};
getCurrentWebview().onDragDropEvent((e) => {
  const p = e.payload;
  if (p.type === 'enter' || p.type === 'over') $('drop').classList.add('show');
  else $('drop').classList.remove('show');
  if (p.type === 'drop') {
    const f = p.paths.find((x) => /\.lrc$/i.test(x));
    if (f) bindFile(f); else tip('只能拖入 .lrc 歌詞檔');
  }
});

// ================= 設定 =================
let settings: Settings;
const SUNG: [string, string, string][] = [
  ['藍紫', '#62d0ff', '#b98cff'], ['粉紅', '#ffa6dc', '#ff5f9a'], ['金黃', '#ffe66b', '#ffa834'], ['薄荷', '#8affc1', '#2fc9a0'], ['天藍', '#62d0ff', '#62d0ff'],
];
const UNSUNG: [string, string][] = [['白', '#ffffff'], ['淺黃', '#fff4c4'], ['淺藍', '#d9efff']];

async function save(patch: Parameters<typeof api.settingsSet>[0]) {
  settings = await api.settingsSet(patch);
  paintSettings();
}
function paintSettings() {
  const s = settings, y = s.style;
  document.querySelectorAll<HTMLElement>('[data-font]').forEach((b) => b.classList.toggle('active', b.dataset.font === y.font));
  document.querySelectorAll<HTMLElement>('[data-lines]').forEach((b) => b.classList.toggle('active', +b.dataset.lines! === y.lines));
  document.querySelectorAll<HTMLElement>('#sungSw .sw').forEach((b) => b.classList.toggle('on', b.dataset.from === y.sungFrom && b.dataset.to === y.sungTo));
  document.querySelectorAll<HTMLElement>('#unsungSw .sw').forEach((b) => b.classList.toggle('on', b.dataset.c === y.unsung));
  $('outlineBtn').classList.toggle('active', y.outline);
  $('shadowBtn').classList.toggle('active', y.shadow);
  $('transBtn').classList.toggle('active', s.showTranslation);
  $('romaBtn').classList.toggle('active', s.showRomaji);
  const lv = Math.round((y.opacity - 0.3) / 0.1);
  $('opacityBlocks').innerHTML = Array.from({ length: 8 }, (_, i) => `<i data-lv="${i}" class="${i <= lv ? 'on' : ''}"></i>`).join('');
  $('opacityBlocks').querySelectorAll<HTMLElement>('i').forEach((b) => { b.onclick = () => save({ style: { opacity: Math.round((0.3 + +b.dataset.lv! * 0.1) * 10) / 10 } }); });
  $('opacityVal').textContent = Math.round(y.opacity * 100) + '%';
  $('gVal').textContent = secs(s.globalOffsetMs);
  $('s2tBtn').classList.toggle('active', s.s2t);
  document.querySelectorAll<HTMLElement>('[data-prov]').forEach((b) => b.classList.toggle('active', s.providers[b.dataset.prov as 'netease']));
  $('lrcDirText').textContent = s.lrcDir || '（沒有設定）';
  $('lrcDirClear').hidden = !s.lrcDir;
  $('updAutoBtn').classList.toggle('active', s.checkUpdates);
  paintHotkeys();
  paintSources();
}
$('sungSw').innerHTML = SUNG.map(([n, a, b]) => `<button class="sw" title="${n}" data-from="${a}" data-to="${b}" style="background:linear-gradient(${a},${b})"></button>`).join('');
$('unsungSw').innerHTML = UNSUNG.map(([n, c]) => `<button class="sw" title="${n}" data-c="${c}" style="background:${c}"></button>`).join('');
document.querySelectorAll<HTMLElement>('#sungSw .sw').forEach((b) => { b.onclick = () => save({ style: { sungFrom: b.dataset.from, sungTo: b.dataset.to } }); });
document.querySelectorAll<HTMLElement>('#unsungSw .sw').forEach((b) => { b.onclick = () => save({ style: { unsung: b.dataset.c } }); });
document.querySelectorAll<HTMLElement>('[data-font]').forEach((b) => { b.onclick = () => save({ style: { font: b.dataset.font as 'pixel' } }); });
document.querySelectorAll<HTMLElement>('[data-lines]').forEach((b) => { b.onclick = () => save({ style: { lines: +b.dataset.lines! as 1 | 2 } }); });
$('outlineBtn').onclick = () => save({ style: { outline: !settings.style.outline } });
$('shadowBtn').onclick = () => save({ style: { shadow: !settings.style.shadow } });
$('transBtn').onclick = () => save({ showTranslation: !settings.showTranslation });
$('romaBtn').onclick = () => save({ showRomaji: !settings.showRomaji });
$('gEarlier').onclick = () => save({ globalOffsetMs: settings.globalOffsetMs + 50 });
$('gLater').onclick = () => save({ globalOffsetMs: settings.globalOffsetMs - 50 });
$('gVal').onclick = () => save({ globalOffsetMs: 0 });
$('s2tBtn').onclick = () => save({ s2t: !settings.s2t });
document.querySelectorAll<HTMLElement>('[data-prov]').forEach((b) => {
  b.onclick = () => {
    const k = b.dataset.prov as keyof Settings['providers'];
    const next = { ...settings.providers, [k]: !settings.providers[k] };
    // 可以全部關掉（隱私：不想把歌名送出去的人只用本機 LRC）
    if (!next.netease && !next.kugou && !next.lrclib) tip('已關掉所有網路歌詞來源：只會用本機 LRC 檔，不會連網查歌詞', 5000);
    save({ providers: next });
  };
});
$('lrcDirPick').onclick = async () => {
  const p = await open({ directory: true, multiple: false });
  if (typeof p === 'string') { await save({ lrcDir: p }); tip('之後會先找這個資料夾裡的 .lrc'); }
};
$('lrcDirClear').onclick = () => save({ lrcDir: '' });
listen<Settings>('settings', ({ payload }) => { settings = payload; paintSettings(); paintLyricList(); });

// ================= 快捷鍵 =================
const HK_LABEL: Record<HotkeyAction, string> = {
  toggle: '顯示 / 隱藏字幕', edit: '移動字幕', earlier: '歌詞提早 0.25 秒', later: '歌詞延後 0.25 秒',
  earlierFine: '歌詞提早 0.05 秒', laterFine: '歌詞延後 0.05 秒', resetOffset: '本首偏移歸零', research: '重新搜尋歌詞',
};
let hkStatus: HotkeyStatus[] = [];
let recording: HotkeyAction | null = null;
let defaults: Settings | null = null;

function paintHotkeys() {
  if (!settings) return;
  const rows = (Object.keys(HK_LABEL) as HotkeyAction[]).map((a) => {
    const accel = settings.hotkeys[a] ?? '';
    const stt = hkStatus.find((h) => h.action === a);
    const bad = stt && !stt.ok;
    const keys = recording === a ? '<kbd class="rec">請按新的組合鍵…</kbd>' : accel ? accel.split('+').map((k) => `<kbd class="${bad ? 'bad' : ''}">${esc(k)}</kbd>`).join(' + ') : '<span class="muted small">（未設定）</span>';
    return `<div class="name">${HK_LABEL[a]}</div><div>${keys}</div>
      <div class="seg"><button class="btn sm" data-rec="${a}">${recording === a ? '取消' : '改'}</button>${defaults && defaults.hotkeys[a] !== accel ? `<button class="btn sm" data-def="${a}">預設</button>` : ''}</div>
      ${bad ? `<div class="err">${esc(stt!.error ?? '無法註冊')}，請換一個組合鍵</div>` : ''}`;
  });
  $('hkTable').innerHTML = rows.join('');
  $('hkTable').querySelectorAll<HTMLElement>('[data-rec]').forEach((b) => { b.onclick = () => startRecord(b.dataset.rec as HotkeyAction); });
  $('hkTable').querySelectorAll<HTMLElement>('[data-def]').forEach((b) => {
    b.onclick = () => save({ hotkeys: { [b.dataset.def!]: defaults!.hotkeys[b.dataset.def as HotkeyAction] } });
  });
  const bad = hkStatus.filter((h) => !h.ok);
  $('hkWarn').classList.toggle('show', bad.length > 0);
  $('hkWarn').textContent = bad.length ? `有 ${bad.length} 個快捷鍵被其他程式佔用（${bad.map((h) => HK_LABEL[h.action]).join('、')}），可到「設定」換一個。其他功能照常可用。` : '';
}

async function startRecord(a: HotkeyAction) {
  if (recording === a) { stopRecord(); return; }
  recording = a;
  await api.hotkeysSuspend(true);      // 錄製時先暫停，避免按下去就觸發
  paintHotkeys();
}
async function stopRecord(accel?: string) {
  const a = recording;
  recording = null;
  if (a && accel) await save({ hotkeys: { [a]: accel } });   // 存設定時 Rust 會重新註冊
  else await api.hotkeysSuspend(false);
  paintHotkeys();
}
const KEYNAME: Record<string, string> = { BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", Backquote: '`', Backslash: '\\' };
addEventListener('keydown', (e) => {
  if (!recording) return;
  e.preventDefault();
  if (e.key === 'Escape') { stopRecord(); return; }
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
  if (!e.ctrlKey && !e.altKey && !e.shiftKey) { tip('要按住 Ctrl、Alt 或 Shift 其中一個'); return; }
  const key = KEYNAME[e.code] ?? e.code.replace(/^Key/, '').replace(/^Digit/, '');
  const accel = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', key].filter(Boolean).join('+');
  stopRecord(accel);
});
listen<HotkeyStatus[]>('hotkeys-status', ({ payload }) => { hkStatus = payload; paintHotkeys(); });

// ================= 其他 =================
$('autostartBtn').onclick = async () => {
  try {
    const on = await api.autostartSet(!$('autostartBtn').classList.contains('active'));
    $('autostartBtn').classList.toggle('active', on);
  } catch (e) { tip('設定失敗：' + e); }
};
$('openData').onclick = () => api.openDataDir();
$('updAutoBtn').onclick = () => save({ checkUpdates: !settings.checkUpdates });

// ================= 新版本提示 =================
function paintUpdate(u: UpdateStatus) {
  $('updBar').classList.toggle('show', u.available && !u.dismissed);
  if (u.available) $('updText').textContent = `有新版本 v${u.latest}（你現在是 v${u.current}），按「下載新版」到 GitHub 下載安裝檔，裝在原本的版本上就好，設定和歌詞都會保留。`;
}
$('updGet').onclick = () => api.updateOpen();
$('updLater').onclick = () => api.updateDismiss();
$('updCheck').onclick = async () => {
  const b = $<HTMLButtonElement>('updCheck');
  b.disabled = true;
  try {
    const u = await api.updateCheck();
    paintUpdate(u);
    if (u.available) tip(`有新版本 v${u.latest}，看最上面的提示`);
    else tip(`已經是最新版本 v${u.current}`);
  } catch (e) { tip('檢查失敗，請確認網路：' + e, 5000); }
  finally { b.disabled = false; }
};
listen<UpdateStatus>('update', ({ payload }) => paintUpdate(payload));
api.updateStatus().then(paintUpdate).catch(() => {});

// ================= 關於 =================
$('openLicense').onclick = () => api.openDoc('license').catch((e) => tip('打不開：' + e));
$('openNotices').onclick = () => api.openDoc('notices').catch((e) => tip('打不開：' + e));
$('promo').onclick = () => api.openLink('site');
$('openGithub').onclick = $('starBtn').onclick = () => api.openLink('github');
$('feedbackBtn').onclick = () => api.openLink('feedback');
$('donateBtn').onclick = $('donateMini').onclick = () => api.openLink('donate');
// 沒設定網址的連結（例如斗內還沒申請好）整塊藏起來
api.linksEnabled().then((on) => {
  document.querySelectorAll<HTMLElement>('[data-link]').forEach((el) => { el.hidden = !on.includes(el.dataset.link as never); });
}).catch(() => {});
getVersion().then((v) => { $('aboutVer').textContent = 'v' + v; }).catch(() => {});

// ================= 啟動 =================
(async () => {
  [settings, ui, hkStatus, defaults] = await Promise.all([api.settingsGet(), api.uiState(), api.hotkeysStatus(), api.settingsDefaults()]);
  paintSettings();
  paintUi();
  $('autostartBtn').classList.toggle('active', await api.autostartGet().catch(() => false));
  $('dataPath').textContent = await api.dataDirPath();
  cmd({ type: 'hello' });
})();
