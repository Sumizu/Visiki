import type { LyricCue } from './types';

/** Parse timestamps without tying playback to a particular lyric provider. */
function timestamp(minutes: string, seconds: string, fraction = ''): number {
  return Number(minutes) * 60 + Number(seconds) + (fraction ? Number(`0.${fraction}`) : 0);
}

function combineAtSameTime(cues: LyricCue[]): LyricCue[] {
  const ordered = cues.filter(c => Number.isFinite(c.time) && c.text.trim()).sort((a, b) => a.time - b.time);
  const result: LyricCue[] = [];
  for (const cue of ordered) {
    const previous = result[result.length - 1];
    if (previous && Math.abs(previous.time - cue.time) < 0.001) {
      if (cue.text !== previous.text && cue.text !== previous.translation) {
        previous.translation = previous.translation ? `${previous.translation}\n${cue.text}` : cue.text;
      }
      if (cue.end !== undefined) previous.end = Math.max(previous.end ?? 0, cue.end);
    } else {
      result.push({ ...cue });
    }
  }
  return result;
}

function parseLrc(text: string): LyricCue[] {
  // An offset tag applies to the entire document, even if it appears at its end.
  const offsets = [...text.matchAll(/\[offset\s*:\s*([+-]?\d+)\s*\]/gi)];
  const offsetSec = offsets.length ? Number(offsets[offsets.length - 1][1]) / 1000 : 0;
  const cues: LyricCue[] = [];
  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const tags = [...rawLine.matchAll(/\[(\d{1,4}):(\d{1,2})(?:[.:](\d{1,4}))?\]/g)];
    if (!tags.length) continue;
    const content = rawLine
      .replace(/\[(?:\d{1,4}:\d{1,2}(?:[.:]\d{1,4})?)\]/g, '')
      .replace(/<\d{1,4}:\d{1,2}(?:[.:]\d{1,4})?>/g, '')
      .trim();
    if (!content) continue;
    for (const tag of tags) {
      // LRC file offset corrects the recording clock: positive is earlier.
      // User-facing project delay is applied separately, with the opposite sign.
      const time = timestamp(tag[1], tag[2], tag[3]) - offsetSec;
      // Preserve negative corrected times: a later user delay may move them
      // back into the song. Clamping here would break offset cancellation.
      cues.push({ time, text: content });
    }
  }
  return combineAtSameTime(cues);
}

function parseSrt(text: string): LyricCue[] {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r/g, '');
  const pattern = /(?:^|\n)(?:\d+\s*\n)?\s*(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})[^\n]*\n([\s\S]*?)(?=\n\s*\n|$)/g;
  const cues: LyricCue[] = [];
  for (const match of normalized.matchAll(pattern)) {
    const time = Number(match[1]) * 3600 + timestamp(match[2], match[3], match[4]);
    const end = Number(match[5]) * 3600 + timestamp(match[6], match[7], match[8]);
    const lines = match[9].replace(/<[^>]*>/g, '').split('\n').map(s => s.trim()).filter(Boolean);
    if (!lines.length || end < time) continue;
    cues.push({ time, end, text: lines[0], ...(lines.length > 1 ? { translation: lines.slice(1).join('\n') } : {}) });
  }
  return combineAtSameTime(cues);
}

export function parseLyrics(text: string, format?: 'lrc' | 'srt'): LyricCue[] {
  return format === 'srt' || (!format && /\d+:\d{2}:\d{2}[,.]\d+\s*-->/.test(text))
    ? parseSrt(text) : parseLrc(text);
}

/** Match translations by their timestamps; never guess a line-number pairing. */
export function mergeBilingual(original: string, translated: string): LyricCue[] {
  const cues = parseLyrics(original);
  const translations = parseLyrics(translated);
  if (!cues.length) return translations;
  let translatedIndex = 0;
  return cues.map(cue => {
    while (translatedIndex < translations.length && translations[translatedIndex].time < cue.time - 0.08) translatedIndex++;
    const translation = translations[translatedIndex];
    if (translation && Math.abs(translation.time - cue.time) <= 0.08 && translation.text !== cue.text) {
      return { ...cue, translation: [cue.translation, translation.text, translation.translation].filter(Boolean).join('\n') };
    }
    return { ...cue };
  });
}

/** Binary search makes scrubbing independent of the previous playback position. */
export function activeLyricIndex(cues: LyricCue[], timeSec: number): number {
  let low = 0;
  let high = cues.length - 1;
  let result = -1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (cues[mid].time <= timeSec) { result = mid; low = mid + 1; } else high = mid - 1;
  }
  if (result >= 0 && cues[result].end !== undefined && timeSec >= cues[result].end!) return -1;
  return result;
}
