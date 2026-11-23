/**
 * Native Node implementation of the search → select → original/translation/romaji
 * workflow researched in jitwxs/163MusicLyrics (Apache-2.0).
 * No upstream source, encryption constants, binary, cookies or account credentials
 * are included. Protocol references and verification: docs/lyrics-integration.md.
 */
export type MusicProvider = 'netease' | 'qq';

export interface SongCandidate {
  id: string;
  title: string;
  artists: string[];
  album: string;
  durationMs: number;
  coverUrl: string;
  provider: MusicProvider;
}

export interface SongLyrics extends SongCandidate {
  originalLrc: string;
  translatedLrc: string;
  romanizedLrc: string;
  sourceUrl: string;
  noLyrics: boolean;
  message?: string;
}

export type LyricsErrorCode =
  | 'invalid_input' | 'unsupported_provider' | 'timeout' | 'network'
  | 'upstream_http' | 'upstream_rejected' | 'malformed_response'
  | 'not_found' | 'redirect_blocked' | 'redirect_limit';

export class LyricsProviderError extends Error {
  readonly status: number;
  readonly code: LyricsErrorCode;
  constructor(code: LyricsErrorCode, message: string, status = 502) {
    super(message);
    this.name = 'LyricsProviderError';
    this.code = code;
    this.status = status;
  }
}

export type ParsedNeteaseInput =
  | { kind: 'id'; id: string }
  | { kind: 'share'; url: string }
  | { kind: 'keyword'; query: string };

const API_ORIGIN = 'https://music.163.com';
const ALLOWED_HOSTS = new Set(['music.163.com', 'y.music.163.com', '163cn.tv', 'www.163cn.tv']);
const MAX_REDIRECTS = 4;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 12_000;
const SONG_ID = /^\d{1,18}$/;
type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject : undefined;
}

function normalizeId(value: unknown): string | undefined {
  const id = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
  if (!SONG_ID.test(id) || /^0+$/.test(id)) return undefined;
  return id.replace(/^0+/, '');
}

function validateMusicUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); }
  catch { throw new LyricsProviderError('invalid_input', '歌曲链接格式不正确。', 400); }
  if (!['http:', 'https:'].includes(url.protocol) || !ALLOWED_HOSTS.has(url.hostname)
    || url.username || url.password || (url.port && url.port !== '443' && url.port !== '80')) {
    throw new LyricsProviderError('redirect_blocked', '仅支持网易云音乐官方歌曲链接或 163cn.tv 分享短链接。', 400);
  }
  // Old HTTP share links are always requested over HTTPS.
  url.port = '';
  url.protocol = 'https:';
  return url;
}

function songIdFromUrl(url: URL): string | undefined {
  let route = url;
  if (url.hash.startsWith('#/')) {
    try { route = new URL(url.hash.slice(1), url.origin); } catch { return undefined; }
  }
  const pathId = route.pathname.match(/^\/(?:m\/)?song\/(\d+)\/?$/)?.[1];
  if (pathId) return normalizeId(pathId);
  if (/^\/(?:m\/)?song\/?$/.test(route.pathname)) return normalizeId(route.searchParams.get('id'));
  return undefined;
}

/** Accept IDs, canonical/hash/mobile song links, or text copied by the share menu. */
export function parseNeteaseInput(input: string): ParsedNeteaseInput {
  const value = input.trim();
  if (!value || value.length > 1000) {
    throw new LyricsProviderError('invalid_input', '请输入歌曲链接、歌曲 ID，或歌名 / 歌手（不超过 1000 字）。', 400);
  }
  const id = normalizeId(value);
  if (id) return { kind: 'id', id };
  if (/^\d+$/.test(value)) throw new LyricsProviderError('invalid_input', '歌曲 ID 必须是 1–18 位正整数。', 400);

  const extracted = value.match(/https?:\/\/[^\s<>"']+/i)?.[0]
    ?.replace(/[)\]}>，。；、！!）】」》]+$/, '');
  const bareUrl = /^(?:music\.163\.com|y\.music\.163\.com|(?:www\.)?163cn\.tv)\//i.test(value)
    ? `https://${value}` : undefined;
  if (extracted || bareUrl || /^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    const url = validateMusicUrl(extracted || bareUrl || value);
    const songId = songIdFromUrl(url);
    if (songId) return { kind: 'id', id: songId };
    if (/\/(?:m\/)?(?:album|playlist)(?:\/|$)/.test(url.pathname)
      || /#\/(?:album|playlist)/.test(url.hash)) {
      throw new LyricsProviderError('invalid_input', 'Demo 支持单曲链接；请使用歌曲链接，或输入歌名搜索。', 400);
    }
    if (url.hostname.endsWith('163cn.tv') || /\/share(?:\/|$)/.test(url.pathname)) {
      return { kind: 'share', url: url.href };
    }
    throw new LyricsProviderError('invalid_input', '未在链接中识别到歌曲 ID；请复制单曲链接或使用歌名搜索。', 400);
  }
  return { kind: 'keyword', query: value };
}

function assertProvider(provider: MusicProvider): void {
  if (provider !== 'netease') {
    throw new LyricsProviderError('unsupported_provider', '当前 Demo 已接入网易云音乐；QQ 音乐尚未通过接口验证。', 400);
  }
}

async function readLimited(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new LyricsProviderError('malformed_response', '歌词服务返回的数据过大，请稍后重试。');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

async function request(url: URL): Promise<Response> {
  try {
    return await fetch(url, {
      method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Accept: 'application/json, text/plain;q=0.9, */*;q=0.5',
        Referer: `${API_ORIGIN}/`,
        'User-Agent': 'VisikiMusicVideoEditor/0.1 (+local desktop lyrics lookup)',
      },
    });
  } catch (error) {
    if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) {
      throw new LyricsProviderError('timeout', '连接网易云歌词服务超时，请检查网络后重试。', 504);
    }
    throw new LyricsProviderError('network', '无法连接网易云歌词服务，请检查网络或稍后重试。');
  }
}

function assertUpstreamSuccess(data: JsonObject): void {
  if (data.code === 200) return;
  if ([301, 401, 403, 50000005].includes(Number(data.code))) {
    throw new LyricsProviderError('upstream_rejected', '网易云要求登录或拒绝了此次访问；Demo 不绕过账号或地区限制。');
  }
  if (!('code' in data)) throw new LyricsProviderError('malformed_response', '网易云返回了无法识别的数据，请稍后重试。');
  throw new LyricsProviderError('upstream_rejected', `网易云歌词服务暂不可用（服务代码 ${String(data.code)}），请稍后重试。`);
}

async function requestJson(path: string, params: Record<string, string>): Promise<JsonObject> {
  const url = new URL(path, API_ORIGIN);
  url.search = new URLSearchParams(params).toString();
  const response = await request(url);
  if (!response.ok) {
    await response.body?.cancel();
    throw new LyricsProviderError('upstream_http', `网易云服务返回 HTTP ${response.status}，请稍后重试。`);
  }
  let raw: string;
  try { raw = await readLimited(response); }
  catch (error) {
    if (error instanceof LyricsProviderError) throw error;
    if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) {
      throw new LyricsProviderError('timeout', '读取网易云歌词超时，请重试。', 504);
    }
    throw new LyricsProviderError('network', '读取网易云响应时连接中断，请重试。');
  }
  let data: JsonObject | undefined;
  try { data = object(JSON.parse(raw)); } catch { /* Report format failure below. */ }
  if (!data) throw new LyricsProviderError('malformed_response', '网易云未返回有效 JSON；可能遇到服务维护或访问限制。');
  assertUpstreamSuccess(data);
  return data;
}

/** Response normalization supports both public API and current web API field names. */
export function normalizeNeteaseSong(input: unknown): SongCandidate | undefined {
  const song = object(input);
  const id = normalizeId(song?.id);
  if (!song || !id || typeof song.name !== 'string' || !song.name.trim()) return undefined;
  const album = object(song.album) || object(song.al);
  const artists = song.artists || song.ar;
  const duration = Number(song.duration ?? song.dt ?? 0);
  const cover = album?.picUrl || album?.blurPicUrl;
  let coverUrl = '';
  if (typeof cover === 'string') {
    try {
      const url = new URL(cover);
      if (['http:', 'https:'].includes(url.protocol) && /(?:^|\.)music\.126\.net$/.test(url.hostname)) {
        url.protocol = 'https:';
        coverUrl = url.href;
      }
    } catch { /* A missing cover does not prevent lyric import. */ }
  }
  return {
    id, title: song.name,
    artists: Array.isArray(artists) ? artists.flatMap((artist) => {
      const name = object(artist)?.name;
      return typeof name === 'string' && name ? [name] : [];
    }) : [],
    album: typeof album?.name === 'string' ? album.name : '',
    durationMs: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : 0,
    coverUrl, provider: 'netease',
  };
}

export function normalizeNeteaseLyrics(input: unknown, song: SongCandidate): SongLyrics {
  const data = object(input);
  if (!data) throw new LyricsProviderError('malformed_response', '歌词响应格式不正确。');
  assertUpstreamSuccess(data);
  if (!['lrc', 'tlyric', 'romalrc', 'nolyric', 'uncollected', 'needDesc'].some((key) => key in data)) {
    throw new LyricsProviderError('malformed_response', '网易云响应缺少歌词字段，请稍后重试。');
  }
  const lrc = (key: string): string => {
    const value = object(data[key])?.lyric;
    return typeof value === 'string' ? value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim() : '';
  };
  const originalLrc = lrc('lrc');
  const translatedLrc = lrc('tlyric');
  const romanizedLrc = lrc('romalrc');
  const noLyrics = !originalLrc && !translatedLrc && !romanizedLrc;
  return {
    ...song, originalLrc, translatedLrc, romanizedLrc,
    sourceUrl: `${API_ORIGIN}/song?id=${song.id}`,
    noLyrics,
    ...(noLyrics ? { message: data.nolyric === true
      ? '网易云将此歌曲标记为纯音乐，未提供歌词。'
      : '网易云尚未提供此歌曲的可用歌词。' } : {}),
  };
}

async function resolveShareUrl(input: string): Promise<string> {
  let url = validateMusicUrl(input);
  for (let count = 0; count <= MAX_REDIRECTS; count++) {
    const id = songIdFromUrl(url);
    if (id) return id;
    const response = await request(url);
    await response.body?.cancel();
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      throw new LyricsProviderError('invalid_input', '分享链接未跳转到网易云单曲；请复制完整歌曲链接或输入歌名。', 400);
    }
    const location = response.headers.get('location');
    if (!location) throw new LyricsProviderError('malformed_response', '分享服务缺少跳转地址，请改用歌曲 ID。');
    if (count === MAX_REDIRECTS) throw new LyricsProviderError('redirect_limit', '分享链接跳转次数过多，请改用完整歌曲链接。', 400);
    // Validate every hop before fetching it; arbitrary user URLs never reach fetch.
    url = validateMusicUrl(new URL(location, url).href);
  }
  throw new LyricsProviderError('redirect_limit', '分享链接跳转次数过多。', 400);
}

async function songDetail(id: string): Promise<SongCandidate> {
  const data = await requestJson('/api/song/detail', { ids: `[${id}]` });
  if (!Array.isArray(data.songs)) throw new LyricsProviderError('malformed_response', '网易云歌曲详情格式已变化，请稍后重试。');
  const song = data.songs.map(normalizeNeteaseSong).find((candidate) => candidate?.id === id);
  if (!song) throw new LyricsProviderError('not_found', '未找到这首歌曲；它可能已下架，或链接中的 ID 不正确。', 404);
  return song;
}

/** Search by song/artist keyword or resolve a shared song URL / numeric song ID. */
export async function searchSongs(query: string, provider: MusicProvider = 'netease'): Promise<SongCandidate[]> {
  assertProvider(provider);
  const input = parseNeteaseInput(query);
  if (input.kind !== 'keyword') {
    const id = input.kind === 'id' ? input.id : await resolveShareUrl(input.url);
    return [await songDetail(id)];
  }
  const data = await requestJson('/api/search/get', { s: input.query, type: '1', limit: '20', offset: '0' });
  const result = object(data.result);
  if (!result) throw new LyricsProviderError('malformed_response', '网易云搜索结果格式已变化，请稍后重试。');
  if (!Array.isArray(result.songs)) {
    if (result.songCount === 0) return [];
    throw new LyricsProviderError('malformed_response', '网易云搜索结果缺少歌曲列表，请稍后重试。');
  }
  const songs = result.songs.slice(0, 20).map(normalizeNeteaseSong).filter((song): song is SongCandidate => Boolean(song));
  if (result.songs.length && !songs.length) throw new LyricsProviderError('malformed_response', '网易云搜索结果缺少歌曲信息，请稍后重试。');
  return songs;
}

/** Fetch text only: original, translated and romanized LRC. Never requests audio. */
export async function fetchSongLyrics(id: string, provider: MusicProvider = 'netease'): Promise<SongLyrics> {
  assertProvider(provider);
  const input = parseNeteaseInput(id);
  if (input.kind === 'keyword') throw new LyricsProviderError('invalid_input', '请先搜索并选择一首歌曲。', 400);
  const songId = input.kind === 'id' ? input.id : await resolveShareUrl(input.url);
  const [song, lyrics] = await Promise.all([
    songDetail(songId),
    requestJson('/api/song/lyric', { id: songId, lv: '-1', tv: '-1', rv: '-1' }),
  ]);
  return normalizeNeteaseLyrics(lyrics, song);
}
