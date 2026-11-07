import { describe, expect, it } from 'vitest';
import { buildTrack, cleanTitle, splitArtists, looksLikeAd } from '../web/core/normalize';
import { buildDoc, finish, parseLrc, parseYrc, parseKrc, detectFormat, isJunk } from '../web/core/lrc-parser';
import { kugouQueries, splitKrc } from '../web/providers/kugou';
import { LyricsService } from '../web/core/lyrics';
import { appName, pickSession } from '../web/sources/smtc';
import { scoreCandidate, AUTO_ACCEPT } from '../web/core/match';
import { PlaybackClock } from '../web/core/clock';
import { lineTokens, progressPx, lineIndexAt, weight } from '../web/core/timing';
import { normKey, similarity } from '../web/core/text';

const smtc = (rawTitle: string, rawArtist: string, durationMs?: number) =>
  buildTrack({ source: 'smtc', appName: 'YT Music', rawTitle, rawArtist, durationMs });

describe('normalize（NORM-1~6）', () => {
  it('YT Music 的合唱版：拆歌手、去括號、中英拆開', () => {
    const t = smtc('甲乙丙丁Strangers (合唱版)', '李佳薇和張新成');
    expect(t.title).toBe('甲乙丙丁Strangers');
    expect(t.titleVariants).toEqual(['甲乙丙丁Strangers', '甲乙丙丁', 'Strangers']);
    expect(t.artists.slice(0, 2)).toEqual(['李佳薇', '張新成']);
    expect(t.trackKey).toContain('合唱版');
  });

  it('YouTube 標題「歌手【歌名】Official MV」', () => {
    const t = smtc('周杰倫 Jay Chou【告白氣球 Love Confession】Official MV', '周杰倫 Jay Chou');
    expect(t.title).toBe('告白氣球 Love Confession');
    expect(t.titleVariants).toContain('告白氣球');
    expect(t.artists).toEqual(expect.arrayContaining(['周杰倫 Jay Chou', '周杰倫', 'Jay Chou']));
  });

  it('頻道名當歌手時拆「歌手 - 歌名」', () => {
    const t = smtc('Bruno Mars - Just The Way You Are (Official Music Video)', 'Bruno Mars');
    expect(t.title).toBe('Just The Way You Are');
    expect(t.artist).toBe('Bruno Mars');
    const v = smtc('Daniel Powter - Bad Day', 'DanielPowterVEVO');
    expect(v.title).toBe('Bad Day');
    expect(v.artist).toBe('Daniel Powter');
  });

  it('歌手欄可信時，「歌名 - 主題曲」取左邊', () => {
    const t = smtc('傘下 - 電視劇主題曲', '張宇');
    expect(t.title).toBe('傘下');
    expect(t.artist).toBe('張宇');
  });

  it('Topic 頻道與 feat.', () => {
    const t = smtc('In Too Deep (feat. Why Don\'t We)', 'Sum 41 - Topic');
    expect(t.artist).toBe('Sum 41');
    expect(t.title).toBe('In Too Deep');
    expect(t.artists).toContain("Why Don't We");
  });

  it('雜訊括號與動態歌詞', () => {
    expect(cleanTitle('夢醒時分【動態歌詞】').title).toBe('夢醒時分');
    expect(cleanTitle('淚海 (高音質) [HD]').title).toBe('淚海');
    expect(cleanTitle('天使 Lyric Video').title).toBe('天使');
  });

  it('trackKey 繁簡、全半形一致', () => {
    expect(smtc('看著我的眼睛說', '張遠').trackKey).toBe(smtc('看着我的眼睛说', '张远').trackKey);
    expect(normKey('ＡＢＣ　１２３')).toBe('abc123');
  });

  it('拆歌手不拆壞人名', () => {
    expect(splitArtists('范逸臣、李聖傑')).toEqual(['范逸臣', '李聖傑']);
    expect(splitArtists('蕭和')).toEqual(['蕭和']);
    expect(splitArtists('Sum 41 & Why Don\'t We')).toEqual(['Sum 41', "Why Don't We"]);
  });

  it('廣告', () => {
    expect(looksLikeAd('Advertisement', '')).toBe(true);
    expect(looksLikeAd('淚海', '許茹芸')).toBe(false);
  });
});

describe('lrc-parser（LYR-4）', () => {
  it('標準 LRC：多個時間標記、製作人員過濾、offset', () => {
    const lines = parseLrc('[ti:x]\n[offset:+500]\n[00:01.00]作词 : 某人\n[00:10.50][01:10.50]副歌\n[00:05.2]第一句');
    expect(lines.map((l) => [l.startMs, l.text])).toEqual([[10000, '副歌'], [70000, '副歌'], [4700, '第一句']]);
  });

  it('增強型 LRC 逐字', () => {
    const [l] = parseLrc('[00:01.00]<00:01.00>Hel<00:01.50>lo <00:02.00>world<00:03.00>');
    expect(l.words).toEqual([
      { text: 'Hel', startMs: 1000, endMs: 1500 },
      { text: 'lo ', startMs: 1500, endMs: 2000 },
      { text: 'world', startMs: 2000, endMs: 3000 },
    ]);
  });

  it('網易 yrc，JSON 製作人員行略過', () => {
    const src = '{"t":0,"c":[{"tx":"作词: "},{"tx":"某人"}]}\n[1000,2000](1000,500,0)我(1500,500,0)们(2000,1000,0)走';
    const [l] = parseYrc(src);
    expect(l.text).toBe('我们走');
    expect(l.words?.length).toBe(3);
    expect(detectFormat(src)).toBe('yrc');
  });

  it('簡轉繁、翻譯行、行結束時間上限（OVL-9）', () => {
    const out = finish(parseLrc('[00:01.00]我们的爱\n[00:30.00]下一句'), { s2t: true, translation: '[00:01.00]Our love' });
    expect(out[0].text).toBe('我們的愛');
    expect(out[0].translation).toBe('Our love');
    expect(out[0].endMs).toBe(1000 + 4 * 800);     // 4 個字 × 0.8 秒，不會拖到 30 秒
  });

  it('逐字時間軸繁簡轉換不改字數', () => {
    const doc = buildDoc({ provider: 'netease', format: 'yrc', content: '[0,1000](0,500,0)软(500,500,0)件', matched: '', confidence: 1 }, true);
    expect(doc.lines[0].words?.map((w) => w.text).join('')).toBe('軟件');
    expect(doc.hasWordTiming).toBe(true);
  });

  it('只有純文字（LYR-3）', () => {
    const doc = buildDoc({ provider: 'lrclib', format: 'plain', content: '第一行\n第二行', matched: '', confidence: 1 }, false);
    expect(doc.lines).toEqual([]);
    expect(doc.plainText).toBe('第一行\n第二行');
  });
});

describe('match（LYR-1、LYR-2）', () => {
  const t = smtc('毒藥', '蕭秉治', 240_000);
  it('歌名歌手時長都對 → 自動採用', () => {
    expect(scoreCandidate(t, { title: '毒药', artist: '萧秉治', durationMs: 241_000 })).toBeGreaterThanOrEqual(AUTO_ACCEPT);
  });
  it('已知歌手但不符 → 最高 0.5', () => {
    expect(scoreCandidate(t, { title: '毒药', artist: '周星星', durationMs: 240_000 })).toBeLessThanOrEqual(0.5);
  });
  it('Live 版扣分', () => {
    const live = scoreCandidate(t, { title: '毒药 (Live)', artist: '萧秉治', durationMs: 240_000 });
    expect(live).toBeLessThan(AUTO_ACCEPT);
  });
  it('歌名不像 → 很低', () => {
    expect(scoreCandidate(t, { title: '告白气球', artist: '萧秉治' })).toBeLessThan(0.3);
  });
  it('相似度', () => {
    expect(similarity('Just the Way You Are', 'just the way you are')).toBe(1);
    expect(similarity('甲乙丙丁', '甲乙丙丁Strangers')).toBeGreaterThan(0.8);
  });
});

describe('clock（SYNC-1~3）', () => {
  it('播放中外插、暫停停住', () => {
    const c = new PlaybackClock();
    c.update({ positionMs: 10_000, capturedAt: 0, rate: 1, status: 'playing' }, 0);
    expect(c.now(1000)).toBe(11_000);
    c.update({ positionMs: 11_000, capturedAt: 1000, rate: 1, status: 'paused' }, 1000);
    expect(c.now(5000)).toBe(11_000);
  });
  it('小誤差 300 ms 內平滑校正', () => {
    const c = new PlaybackClock();
    c.update({ positionMs: 0, capturedAt: 0, rate: 1, status: 'playing' }, 0);
    const jumped = c.update({ positionMs: 10_200, capturedAt: 10_000, rate: 1, status: 'playing' }, 10_000);
    expect(jumped).toBe(false);
    expect(c.now(10_000)).toBeCloseTo(10_000);        // 剛收到時還停在舊估計
    expect(c.now(10_150)).toBeCloseTo(10_250);        // 一半
    expect(c.now(10_300)).toBeCloseTo(10_500);        // 校正完
  });
  it('差 > 1.5 秒視為跳轉，立即對齊', () => {
    const c = new PlaybackClock();
    c.update({ positionMs: 0, capturedAt: 0, rate: 1, status: 'playing' }, 0);
    expect(c.update({ positionMs: 120_000, capturedAt: 5000, rate: 1, status: 'playing' }, 5000)).toBe(true);
    expect(c.now(5000)).toBe(120_000);
  });
});

describe('timing（OVL-8）', () => {
  it('沒有逐字時間時依權重分配', () => {
    const toks = lineTokens({ startMs: 0, endMs: 3000, text: '我愛你' });
    expect(toks.map((t) => Math.round(t.endMs))).toEqual([1000, 2000, 3000]);
    expect(weight('Hello world')).toBeCloseTo(5 / 3 + 5 / 3);
  });
  it('半字填色', () => {
    const m = [{ x: 0, w: 10, startMs: 0, endMs: 100 }, { x: 10, w: 10, startMs: 100, endMs: 200 }];
    expect(progressPx(m, 150)).toBe(15);
    expect(progressPx(m, 999)).toBe(20);
    expect(progressPx(m, -5)).toBe(0);
  });
  it('二分搜尋', () => {
    const L = [{ startMs: 0 }, { startMs: 1000 }, { startMs: 2000 }];
    expect(lineIndexAt(L, -1)).toBe(-1);
    expect(lineIndexAt(L, 1500)).toBe(1);
    expect(lineIndexAt(L, 5000)).toBe(2);
  });
});

describe('酷狗 KRC', () => {
  const krc = [
    '[ar:YOASOBI]', '[ti:夜に駆ける]',
    '[64,640]<0,485,0>YOASOBI <485,0,0>- <485,53,0>夜<538,0,0>に<538,51,0>駆<589,51,0>け<640,0,0>る',
    '[704,165]<0,60,0>作<60,51,0>词<111,54,0>：<165,0,0>Ayase',
    '[1671,1767]<0,469,0>沈<469,365,0>む<834,355,0>よ<1189,264,0>う<1453,314,0>に',
  ].join('\n');

  it('逐字時間 = 行起點 + 相對位移；略過「歌手 - 歌名」與作詞行', () => {
    const d = parseKrc(krc);
    expect(d.map((x) => x.text)).toEqual(['沈むように']);
    expect(d[0].words?.[1]).toEqual({ text: 'む', startMs: 1671 + 469, endMs: 1671 + 469 + 365 });
    expect(detectFormat(krc)).toBe('krc');
  });

  it('language 標籤的翻譯與羅馬拼音依行順序轉成 LRC，日文不被簡轉繁改字', () => {
    const lang = { content: [
      { type: 1, language: 0, lyricContent: [[' '], [' '], ['宛如沉溺般']] },
      { type: 0, language: 0, lyricContent: [['yo'], [' '], ['shi zu ', 'mu ', 'yo ', 'u ', 'ni ']] },
    ] };
    const b64 = Buffer.from(JSON.stringify(lang)).toString('base64');
    const { content, translation, romaji } = splitKrc(`${krc}\n[language:${b64}]`);
    expect(content).not.toContain('[language:');
    expect(translation).toBe('[00:01.67]宛如沉溺般');
    expect(romaji).toBe('[00:00.06]yo\n[00:01.67]shi zu mu yo u ni');
    const doc = buildDoc({ provider: 'kugou', format: 'krc', content, translation, romaji, matched: '', confidence: 1 }, true);
    expect(doc.lines[0].text).toBe('沈むように');
    expect(doc.lines[0].translation).toBe('宛如沉溺般');
    expect(doc.lines[0].romaji).toBe('shi zu mu yo u ni');   // 被略過的標題行（yo）不會錯配到第一句
    expect(doc.hasWordTiming).toBe(true);
  });

  it('網易雲的羅馬拼音（逐行 LRC）依時間併入，時間差一點也對得到', () => {
    const doc = buildDoc({
      provider: 'netease', format: 'yrc', content: '[851,3000](851,500,0)夢(1351,500,0)ならば\n[6650,3000](6650,500,0)未(7150,500,0)だに',
      romaji: '[00:00.85]yu me na ra ba\n[00:06.70]i ma da ni', matched: '', confidence: 1,
    }, true);
    expect(doc.lines.map((l) => l.romaji)).toEqual(['yu me na ra ba', 'i ma da ni']);
    expect(doc.lines[1].text).toBe('未だに');
  });

  it('日文歌詞不做簡轉繁（残、会、里不被改），中文翻譯照轉；華語歌照轉', () => {
    const ja = finish(parseLrc('[00:01.00]残響散歌\n[00:02.00]会いたいよ\n[00:03.00]優里のうた'), { s2t: true, translation: '[00:02.00]好想见你' });
    expect(ja.map((l) => l.text)).toEqual(['残響散歌', '会いたいよ', '優里のうた']);
    expect(ja[1].translation).toBe('好想見你');
    const zh = finish(parseLrc('[00:01.00]我们的爱\n[00:02.00]我们的回忆'), { s2t: true });
    expect(zh[0].text).toBe('我們的愛');
    const doc = buildDoc({ provider: 'kugou', format: 'lrc', content: '[00:01.00]残響散歌\n[00:02.00]会いたいよ', matched: 'Aimer - 残響散歌', confidence: 1 }, true);
    expect(doc.matched).toBe('Aimer - 残響散歌');
  });

  it('組合職稱的製作人員行要略過，一般歌詞（含冒號）保留', () => {
    for (const s of ['制作公司&OP：一寸光年', '總監制：陳國威/許雯靜', '吉他&貝斯：李奕楠', 'Synthesizer Programming：飯田高広', 'Mixing Engineer: Bob']) expect(isJunk(s)).toBe(true);
    for (const s of ['想你的天空 下起雨來', 'Baby: I love you', '時間：停在這一刻', '沈むように']) expect(isJunk(s)).toBe(false);
  });

  it('查詢字串：日文用原文、華語另加簡體', () => {
    expect(kugouQueries(smtc('夜に駆ける', 'YOASOBI'))[0]).toBe('YOASOBI - 夜に駆ける');
    expect(kugouQueries(smtc('告白氣球', '周杰倫'))).toContain('周杰伦 - 告白气球');
  });
});

describe('來源順序與播放器辨識', () => {
  const svc = new LyricsService({} as never, {} as never, {} as never, () => ({ s2t: true, providers: { netease: true, kugou: true, lrclib: true }, lrcDir: '' }));
  it('有假名 → 酷狗先；華語 → 網易雲先；英文 → LRCLIB 先', () => {
    expect(svc.providerOrder(smtc('夜に駆ける', 'YOASOBI'))[0]).toBe('kugou');
    expect(svc.providerOrder(smtc('告白氣球', '周杰倫'))[0]).toBe('netease');
    expect(svc.providerOrder(smtc('Love Story', 'Taylor Swift'))[0]).toBe('lrclib');
  });

  it('AUMID → 播放器名稱', () => {
    expect(appName('Chrome._crx_cinhimbnkkghhklpknlkffjgod')).toBe('YT Music');
    expect(appName('SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify')).toBe('Spotify');
    expect(appName('Spotify.exe')).toBe('Spotify');
    expect(appName('AppleInc.AppleMusicWin_nzyj5cx40ttqa!App')).toBe('Apple Music');
    expect(appName('Chrome._crx_abcdefghijklmnop')).toBe('網頁 App');
    expect(appName('308046B0AF4A39CB')).toBe('Firefox');
    expect(appName('C:\\Apps\\Foo\\foo.exe')).toBe('foo');
  });

  it('YT Music 播放中優先；否則挑正在播的認得的播放器', () => {
    const s = (aumid: string, status: 'playing' | 'paused', isCurrent = false) =>
      ({ aumid, title: 't', artist: 'a', album: '', status, positionMs: 0, endMs: 0, lastUpdatedUnixMs: 0, rate: 1, isCurrent });
    const ytm = 'Chrome._crx_cinhimbnkkghhklpknlkffjgod', sp = 'Spotify.exe';
    expect(pickSession([s(sp, 'playing'), s(ytm, 'playing')], null)?.aumid).toBe(ytm);
    expect(pickSession([s(ytm, 'paused'), s('Some.Game', 'playing', true), s(sp, 'playing')], null)?.aumid).toBe(sp);
    expect(pickSession([s(ytm, 'paused'), s(sp, 'playing')], ytm)?.aumid).toBe(ytm);
  });

  it('同時在播時，有歌曲長度的優先於直播（沒有長度）', () => {
    const s = (aumid: string, endMs: number) =>
      ({ aumid, title: 't', artist: 'a', album: '', status: 'playing' as const, positionMs: 0, endMs, lastUpdatedUnixMs: 0, rate: 1, isCurrent: false });
    expect(pickSession([s('Chrome', 0), s('Chrome._crx_otherytmappid', 240_000)], null)?.aumid).toBe('Chrome._crx_otherytmappid');
    expect(pickSession([s('Chrome', 3 * 3600_000), s('Spotify.exe', 200_000)], null)?.aumid).toBe('Spotify.exe');
    expect(pickSession([s('Chrome', 0)], null)?.aumid).toBe('Chrome');   // 只有直播時照樣選它
  });

  it('Spotify 廣告', () => {
    expect(looksLikeAd('Advertisement', '')).toBe(true);
    expect(looksLikeAd('Listen ad-free', 'Spotify')).toBe(true);
    expect(looksLikeAd('Love Story', 'Taylor Swift')).toBe(false);
  });
});
