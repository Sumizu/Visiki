import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fetchSongLyrics, LyricsProviderError, normalizeNeteaseLyrics,
  normalizeNeteaseSong, parseNeteaseInput, searchSongs,
} from '../server/lyrics-provider.ts';

const song = normalizeNeteaseSong({
  id: 186016, name: '测试曲', duration: 269000,
  artists: [{ name: '测试歌手' }], album: { name: '测试专辑' },
})!;

test('recognizes canonical, hash, mobile and path song links and share-menu prose', () => {
  for (const value of [
    '186016', ' 00186016 ', 'https://music.163.com/song?id=186016&userid=9',
    'https://music.163.com/#/song?id=186016', 'http://y.music.163.com/m/song?id=186016',
    'https://music.163.com/song/186016/', 'music.163.com/#/song?id=186016',
    '分享周杰伦的歌曲 https://music.163.com/song?id=186016 （来自网易云音乐）',
  ]) assert.deepEqual(parseNeteaseInput(value), { kind: 'id', id: '186016' });
  assert.deepEqual(parseNeteaseInput('晴天 周杰伦'), { kind: 'keyword', query: '晴天 周杰伦' });
  assert.deepEqual(parseNeteaseInput('https://163cn.tv/abc123'), { kind: 'share', url: 'https://163cn.tv/abc123' });
});

test('rejects album links, invalid IDs, credentials, local URLs and host suffix spoofing', () => {
  for (const value of ['', '0', '999999999999999999999',
    'https://music.163.com/album?id=186016', 'https://music.163.com/#/playlist?id=186016',
    'http://127.0.0.1/song?id=186016', 'https://music.163.com.evil.test/song?id=186016',
    'https://music.163.com@evil.test/song?id=186016', 'https://u:p@music.163.com/song?id=186016',
    'https://music.163.com:8888/song?id=186016', 'file:///song?id=186016',
  ]) assert.throws(() => parseNeteaseInput(value), LyricsProviderError);
});

test('normalizes old public and current web metadata without guessing missing covers', () => {
  assert.deepEqual(song, {
    id: '186016', title: '测试曲', artists: ['测试歌手'], album: '测试专辑',
    durationMs: 269000, coverUrl: '', provider: 'netease',
  });
  const current = normalizeNeteaseSong({
    id: '12345', name: '海边', dt: 120500, ar: [{ name: '甲' }, { name: '乙' }],
    al: { name: '海', picUrl: 'http://p1.music.126.net/abc.jpg' },
  });
  assert.equal(current?.durationMs, 120500);
  assert.deepEqual(current?.artists, ['甲', '乙']);
  assert.equal(current?.coverUrl, 'https://p1.music.126.net/abc.jpg');
  assert.equal(normalizeNeteaseSong({ id: 1, name: 'X', album: { picUrl: 'http://127.0.0.1/a' } })?.coverUrl, '');
  assert.equal(normalizeNeteaseSong({ id: 2, duration: 3 }), undefined);
});

test('keeps original, translation and romaji separate and preserves LRC timing', () => {
  const result = normalizeNeteaseLyrics({ code: 200,
    lrc: { lyric: '\uFEFF[00:12.345]海へ\r\n[00:16.100]進む' },
    tlyric: { lyric: '[00:12.345]向海出发' }, romalrc: { lyric: '[00:12.345]umi e' },
  }, song);
  assert.equal(result.originalLrc, '[00:12.345]海へ\n[00:16.100]進む');
  assert.equal(result.translatedLrc, '[00:12.345]向海出发');
  assert.equal(result.romanizedLrc, '[00:12.345]umi e');
  assert.equal(result.sourceUrl, 'https://music.163.com/song?id=186016');
  assert.equal(result.noLyrics, false);
});

test('distinguishes genuine no-lyrics from service rejection and malformed response', () => {
  const instrumental = normalizeNeteaseLyrics({ code: 200, nolyric: true }, song);
  assert.equal(instrumental.noLyrics, true);
  assert.match(instrumental.message!, /纯音乐/);
  const uncollected = normalizeNeteaseLyrics({ code: 200, uncollected: true }, song);
  assert.match(uncollected.message!, /尚未提供/);
  assert.throws(() => normalizeNeteaseLyrics({ code: 403 }, song), (e: unknown) =>
    e instanceof LyricsProviderError && e.code === 'upstream_rejected');
  assert.throws(() => normalizeNeteaseLyrics({ code: 200 }, song), (e: unknown) =>
    e instanceof LyricsProviderError && e.code === 'malformed_response');
});

test('short links validate every redirect before sending any request', async (t) => {
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL) => {
    requests.push(url.href);
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } });
  });
  await assert.rejects(searchSongs('https://163cn.tv/abc'), (e: unknown) =>
    e instanceof LyricsProviderError && e.code === 'redirect_blocked');
  assert.deepEqual(requests, ['https://163cn.tv/abc']);
});

test('resolves a legitimate short link to the canonical song, with a redirect ceiling', async (t) => {
  let count = 0;
  t.mock.method(globalThis, 'fetch', async (url: URL) => {
    count++;
    if (url.hostname === '163cn.tv') return new Response(null, { status: 302,
      headers: { location: 'https://y.music.163.com/m/song?id=186016' } });
    assert.equal(url.pathname, '/api/song/detail');
    return Response.json({ code: 200, songs: [{ id: 186016, name: '测试曲' }] });
  });
  const results = await searchSongs('https://163cn.tv/abc');
  assert.equal(results[0].id, '186016');
  assert.equal(count, 2);
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => new Response(null, {
    status: 302, headers: { location: 'https://163cn.tv/again' },
  }));
  await assert.rejects(searchSongs('https://163cn.tv/loop'), (e: unknown) =>
    e instanceof LyricsProviderError && e.code === 'redirect_limit');
});

test('search, lyric failures and timeout remain actionable errors; unknown provider is explicit', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ code: 500 }));
  await assert.rejects(searchSongs('测试'), (e: unknown) => e instanceof LyricsProviderError && e.code === 'upstream_rejected');
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => new Response('maintenance', { status: 503 }));
  await assert.rejects(fetchSongLyrics('186016'), (e: unknown) => e instanceof LyricsProviderError && e.code === 'upstream_http');
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => { throw new DOMException('timeout', 'TimeoutError'); });
  await assert.rejects(searchSongs('测试'), (e: unknown) => e instanceof LyricsProviderError && e.code === 'timeout');
  await assert.rejects(searchSongs('测试', 'qq'), (e: unknown) => e instanceof LyricsProviderError && e.code === 'unsupported_provider');
});

test('zero search results are allowed, but changed search schema is reported', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ code: 200, result: { songCount: 0 } }));
  assert.deepEqual(await searchSongs('不存在的测试歌曲'), []);
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => Response.json({ code: 200, unexpected: [] }));
  await assert.rejects(searchSongs('测试'), (e: unknown) => e instanceof LyricsProviderError && e.code === 'malformed_response');
});
