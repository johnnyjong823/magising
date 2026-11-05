// 歌曲辨識與正規化（SPEC §4.3 NORM-1~7）
import { halfWidth, hasCjk, normKey } from './text';
import type { SourceKind, TrackInfo } from './types';

/** NORM-1：括號裡出現這些字，就把整個括號拿掉 */
const NOISE = /official|music\s*video|\bm\/?v\b|lyrics?|lyric\s*video|\baudio\b|\bhd\b|\b4k\b|\bhq\b|video|visuali[sz]er|官方|完整版|高音質|高音质|動態歌詞|动态歌词|歌詞|歌词|字幕|中字|首播|premiere|topic/i;
/** 不在括號裡的雜訊字樣 */
const LOOSE_NOISE = /\b(official\s+(music\s+)?(video|mv|audio|lyric\s+video)|lyric\s+video|lyrics?\s+video|music\s+video|official|m\/v|mv|lyrics?|hd|4k)\b|動態歌詞|动态歌词|高音質|官方完整版|官方版/gi;
/** 版本標記（LYR-2）：原曲標題有的話，比對時不扣分 */
const VERSION = /\b(live|remix|cover|instrumental|acoustic|karaoke|demo|remaster(ed)?)\b|現場|现场|翻唱|伴奏|純音樂|纯音乐|dj版|合唱版|鋼琴版|钢琴版/gi;

const OPEN = '([（【〔［《「『';
const CLOSE = ')]）】〕］》」』';
const BRACKET = /[([（【〔［《「『]([^()[\]（）【】〔〕［］《》「」『』]*)[)\]）】〕］》」』]/g;

/** NORM-2：歌手欄的頻道字樣 */
function cleanArtist(a: string): string {
  return halfWidth(a)
    .replace(/\s*-\s*topic$/i, '')
    .replace(/\s*(vevo|official|official\s+channel|官方頻道|官方频道|官方|channel|music)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isChannelLike(rawArtist: string): boolean {
  return !rawArtist.trim() || /-\s*topic$|vevo$|official|官方|channel|頻道|频道|music$|records|entertainment|娛樂|娱乐|唱片/i.test(rawArtist);
}

export function versionTagsOf(s: string): string[] {
  return [...new Set([...halfWidth(s).matchAll(VERSION)].map((m) => m[0].toLowerCase()))];
}

/**
 * 清掉標題雜訊（NORM-1），並處理「歌手【歌名】」「歌手《歌名》」寫法。
 * keepVersion = true 時保留其他括號內容（例如「合唱版」），給 trackKey 用。
 */
export function cleanTitle(raw: string, keepVersion = false): { title: string; artistHint?: string } {
  let t = halfWidth(raw).replace(/\s+/g, ' ').trim();
  // 1. 括號裡是雜訊 → 拿掉
  t = t.replace(BRACKET, (m, inner: string) => (NOISE.test(inner) ? ' ' : m));
  t = t.replace(LOOSE_NOISE, ' ').replace(/\s+/g, ' ').trim();
  // 2. 「周杰倫 Jay Chou【告白氣球 Love Confession】」：外面是歌手、裡面是歌名
  let artistHint: string | undefined;
  const wrapped = t.match(/^(.*?)\s*[【《「『]([^】》」』]+)[】》」』]\s*(.*)$/);
  if (wrapped && wrapped[1].trim() && wrapped[2].trim()) {
    artistHint = wrapped[1].replace(/[-–—|｜:：\s]+$/, '').trim();
    t = (wrapped[2] + ' ' + wrapped[3]).trim();
  }
  // 3. 其他括號（合唱版、電視劇主題曲…）
  if (!keepVersion) t = t.replace(BRACKET, ' ');
  t = t.replace(/[-–—|｜:：\s]+$/, '').replace(/^[-–—|｜:：\s]+/, '').replace(/\s+/g, ' ').trim();
  // 沒有成對的殘留括號
  t = t.replace(new RegExp(`[${escapeRe(OPEN + CLOSE)}]`, 'g'), ' ').replace(/\s+/g, ' ').trim();
  return { title: t || halfWidth(raw).trim(), artistHint };
}

function escapeRe(s: string) {
  return s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
}

/** NORM-3：「告白氣球 Love Confession」「甲乙丙丁Strangers」→ 只留中文、只留英文 */
export function bilingualParts(s: string): string[] {
  const m = s.match(/^([^A-Za-z]*\p{Script=Han}[^A-Za-z]*?)\s*([A-Za-z][A-Za-z0-9 '’&.!?,-]*)$/u)
    ?? s.match(/^([A-Za-z][A-Za-z0-9 '’&.!?,-]*?)\s+([^A-Za-z]*\p{Script=Han}[^A-Za-z]*)$/u);
  if (!m) return [];
  return [m[1].trim(), m[2].trim()].filter((x) => x.length > 0);
}

/** NORM-4：拆合唱者。「李佳薇和張新成」「A feat. B」「A & B」 */
export function splitArtists(a: string): string[] {
  const parts = a
    .split(/\s*(?:、|,|，|&|＆|\/|;|；|\s+x\s+|\s+and\s+|\bfeat\.?\s*|\bft\.?\s*|\bwith\s+)\s*/i)
    .flatMap((p) => {
      // 「和 / 與 / 与」只在兩邊都至少兩個字時才當分隔（避免拆壞人名）
      const m = p.match(/^(\S{2,}?)(?:和|與|与)(\S{2,})$/u);
      return m && hasCjk(p) ? [m[1], m[2]] : [p];
    })
    .map((x) => x.trim())
    .filter(Boolean);
  return [...new Set(parts)];
}

/** 從標題拿掉 feat. 合唱者：「Song (feat. X)」「Song ft. X」 */
function stripFeat(t: string): { title: string; feat: string[] } {
  const feat: string[] = [];
  const title = t
    .replace(/[([（]\s*(?:feat\.?|ft\.?|featuring|with)\s+([^)\]）]+)[)\]）]/gi, (_m, who: string) => { feat.push(...splitArtists(who)); return ' '; })
    .replace(/\s+(?:feat\.?|ft\.?|featuring)\s+(.+)$/i, (_m, who: string) => { feat.push(...splitArtists(who)); return ' '; })
    .replace(/\s+/g, ' ')
    .trim();
  return { title, feat };
}

export interface TrackInput {
  source: SourceKind;
  appId?: string;
  appName: string;
  rawTitle: string;
  rawArtist: string;
  album?: string;
  durationMs?: number;
}

export function buildTrack(input: TrackInput): TrackInfo {
  const { rawTitle, rawArtist } = input;
  let artist = cleanArtist(rawArtist);
  // 先從原始標題抽出 feat. 合唱者（之後清括號時會被拿掉）
  const { feat } = stripFeat(halfWidth(rawTitle));
  let { title, artistHint } = cleanTitle(rawTitle);
  let keyTitle = cleanTitle(rawTitle, true).title;

  // NORM-2：「歌手 - 歌名」
  const dash = title.match(/^(.+?)\s+[-–—|｜]\s+(.+)$/) ?? title.match(/^(.+?)\s*[｜|]\s*(.+)$/);
  if (dash) {
    const [left, right] = [dash[1].trim(), dash[2].trim()];
    const leftHasArtist = artist && normKey(left).includes(normKey(artist));
    if (isChannelLike(rawArtist) || leftHasArtist) {
      artist = cleanArtist(left);
      title = right;
      keyTitle = cleanTitle(keyTitle.replace(/^.+?\s+[-–—|｜]\s+/, ''), true).title;
    } else {
      // 歌手欄可信 → 「歌名 - 電影主題曲」這種，主歌名取左邊
      title = left;
    }
  }
  if (artistHint && (isChannelLike(rawArtist) || !artist)) artist = cleanArtist(artistHint);

  title = stripFeat(title).title || title;
  const artists = splitArtists(artist);
  for (const a of [...artists]) for (const part of bilingualParts(a)) if (!artists.includes(part)) artists.push(part);
  for (const f of feat) if (!artists.includes(f)) artists.push(f);

  const titleVariants = [title, ...bilingualParts(title)].filter((x, i, arr) => x && arr.indexOf(x) === i);
  const trackKey = `${normKey(artist)}|${normKey(stripFeat(keyTitle).title || keyTitle)}`;

  return {
    ...input,
    title,
    artist,
    artists,
    titleVariants,
    versionTags: versionTagsOf(rawTitle),
    trackKey,
  };
}

/** SRC-A5：廣告特徵 */
export function looksLikeAd(rawTitle: string, rawArtist: string): boolean {
  const t = rawTitle.trim(), a = rawArtist.trim();
  return /^(advertisement|廣告|广告|ad|sponsored|贊助|赞助)$/i.test(t)
    || /^(advertisement|廣告|广告|sponsored|spotify)$/i.test(a)   // Spotify 免費版插播時歌手欄可能是「Spotify」
    || /video will play after ad|影片將在廣告後播放|廣告結束後/i.test(t);
}
