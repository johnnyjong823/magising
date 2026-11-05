// 實際連網測試歌詞流程命中率（不在 npm test 裡跑）：
//   npx vite-node tests/hitrate.live.ts [songs.json]
// songs.json 格式：["歌名|歌手", …]。Node 版傳輸層模仿 Rust 的節流（網易雲 1.5 秒間隔）
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { buildTrack } from '../web/core/normalize';
import { LyricsService, type Store } from '../web/core/lyrics';
import type { Net } from '../web/providers/deps';

const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
let last = 0;
async function ne(url: string) {
  const wait = last + 1500 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  const r = await fetch(url, { headers: { 'User-Agent': UA_BROWSER, Referer: 'https://music.163.com/' }, signal: AbortSignal.timeout(4000) });
  const j: any = await r.json();
  if (j.code === 405) throw new Error('網易雲限流（405）');
  return j;
}
const lr = async (p: string) => {
  const r = await fetch('https://lrclib.net/api/' + p, { headers: { 'User-Agent': 'MagiSing/0.4.0 (test)' }, signal: AbortSignal.timeout(4000) });
  return r.status === 404 ? null : r.json();
};
const enc = encodeURIComponent;
const kg = async (url: string) => (await fetch(url, { headers: { 'User-Agent': UA_BROWSER }, signal: AbortSignal.timeout(4000) })).json() as any;
const KRC_KEY = [64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105];

const net: Net = {
  async neteaseSearch(k) {
    const j = await ne(`https://music.163.com/api/cloudsearch/pc?s=${enc(k)}&type=1&limit=10`);
    return (j.result?.songs ?? []).map((s: any) => ({ id: s.id, name: s.name, artists: s.ar.map((a: any) => a.name), durationMs: s.dt, album: s.al?.name }));
  },
  async neteaseLyric(id) {
    const j = await ne(`https://music.163.com/api/song/lyric/v1?id=${id}&cp=false&tv=0&lv=0&rv=0&kv=0&yv=0&ytv=0&yrv=0`);
    return { lrc: j.lrc?.lyric ?? '', yrc: j.yrc?.lyric ?? '', tlyric: j.tlyric?.lyric ?? '', romalrc: j.romalrc?.lyric ?? '' };
  },
  lrclibGet: async (q) => lr(`get?track_name=${enc(q.track)}&artist_name=${enc(q.artist)}${q.durationS ? `&duration=${q.durationS}` : ''}`),
  lrclibSearch: async (q) => (await lr(`search?q=${enc(q)}`)) ?? [],
  async kugouSearch(k, d) {
    let hash = '';
    if (!d) {   // 同 Rust：不知道時長時先用歌曲搜尋拿 hash 與時長
      const s = await kg(`http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=${enc(k.replace(' - ', ' '))}&page=1&pagesize=1`).catch(() => null);
      const x = s?.data?.info?.[0];
      if (x) { d = x.duration * 1000; hash = x.hash; }
    }
    const j = await kg(`https://krcs.kugou.com/search?ver=1&man=yes&client=mobi&keyword=${enc(k)}&duration=${d ?? 0}&hash=${hash}`);
    return (j.candidates ?? []).map((c: any) => ({ id: c.id, accesskey: c.accesskey, singer: c.singer, song: c.song, durationMs: c.duration }));
  },
  async kugouLyric(id, accesskey) {
    const j = await kg(`https://lyrics.kugou.com/download?ver=1&client=pc&id=${id}&accesskey=${accesskey}&fmt=krc&charset=utf8`);
    const raw = Buffer.from(j.content, 'base64').subarray(4).map((b, i) => b ^ KRC_KEY[i % 16]);
    return inflateSync(raw).toString('utf8').replace(/^﻿/, '');
  },
};
const mem = new Map<string, any>();
const store: Store = {
  getLyrics: async () => null,
  putLyrics: async (k, r) => { mem.set(k, r); },
  deleteLyrics: async () => {},
  getPref: async () => ({ offsetMs: 0, pinned: false }),
  setPref: async () => {},
};
const svc = new LyricsService(net, { list: async () => [], read: async () => '' }, store,
  // PROVIDERS=kugou 只測某幾個來源（逗號分隔）
  () => {
    const only = process.env.PROVIDERS?.split(',');
    const on = (p: string) => !only || only.includes(p);
    return { s2t: true, providers: { netease: on('netease'), kugou: on('kugou'), lrclib: on('lrclib') }, lrcDir: '' };
  });

const file = process.argv[2] ?? '../spikes/m0-lyrics/songs-with-artist.json';
const songs: string[] = JSON.parse(readFileSync(file, 'utf8'));
let ok = 0;
for (const s of songs) {
  const [title, artist] = s.split('|');
  const track = buildTrack({ source: 'smtc', appName: 'test', rawTitle: title, rawArtist: artist });
  const t0 = Date.now();
  const r = await svc.resolve(track);
  const ms = Date.now() - t0;
  const good = r.status === 'found' || r.status === 'uncertain';
  if (good) ok++;
  console.log(`${good ? '✅' : '❌'} ${s.padEnd(28)} ${r.status.padEnd(9)} ${(r.doc?.provider ?? '').padEnd(7)} ${r.doc?.hasWordTiming ? '逐字' : '逐行'} ${r.doc?.confidence?.toFixed(2) ?? ''} ${r.doc?.matched ?? r.error ?? ''}  ${ms}ms  ${r.doc?.lines[3]?.text ?? ''}`);
  const L = r.doc?.lines ?? [];
  const ro = L.filter((l) => l.romaji).length, tr = L.filter((l) => l.translation).length;
  if (ro || tr) console.log(`      拼音 ${ro}/${L.length} 行、翻譯 ${tr}/${L.length} 行  ${L[3]?.romaji ?? ''}`);
}
console.log(`\n${ok}/${songs.length} 首有同步歌詞`);
