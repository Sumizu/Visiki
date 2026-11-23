import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createDefaultProject, makeLayer } from '../src/default-project';
import { validateProject } from '../src/project-io';
import { BUILTIN_FONTS, collectProjectFonts, fontFamilyForId } from '../src/fonts';
import { inspectFontBuffer } from '../server/fonts';
import type { FontAsset } from '../src/types';

const id = 'b68ee08b-1bd7-4656-9a22-4a5d6b7a22c7';
const imported: FontAsset = { id, name: 'custom.ttf', type: 'font', family: 'untrusted font family', url: 'https://untrusted.invalid/font.ttf' };
test('old projects use system fonts and imported font references are canonicalized', () => {
  const old = createDefaultProject(); delete old.fonts;
  assert.deepEqual(validateProject(old).fonts, []);
  assert.equal(collectProjectFonts(old).length, 0);
  const layer = makeLayer('lyrics'); layer.params.fontId = id;
  const loaded = validateProject({ ...old, fonts: [imported], layers: [layer] });
  assert.equal(loaded.fonts?.[0].family, `VisikiFont_${id.replaceAll('-', '_')}`);
  assert.equal(loaded.fonts?.[0].url, `/api/fonts/${id}`);
  assert.equal(collectProjectFonts(loaded)[0].id, id);
  assert.equal(fontFamilyForId('";url(https://untrusted.invalid)'), fontFamilyForId());
});

test('font libraries reject duplicate IDs and unresolved fonts without affecting old saves', () => {
  const project = createDefaultProject();
  assert.throws(() => validateProject({ ...project, fonts: [imported, imported] }), /字体素材引用/);
  assert.throws(() => validateProject({ ...project, fonts: [BUILTIN_FONTS[0]] }), /字体素材引用/);
  assert.throws(() => validateProject({ ...project, fonts: [{ ...imported, type: 'image' }] }), /字体素材引用/);
  const layer = makeLayer('lyrics'); layer.params.fontId = 'missing-font';
  assert.throws(() => validateProject({ ...project, layers: [layer] }), /字体不在字体库/);
  layer.params.fontId = BUILTIN_FONTS[0].id;
  assert.equal(validateProject({ ...project, layers: [layer] }).layers[0].params.fontId, BUILTIN_FONTS[0].id);
});

test('export waits only for contributing lyric and title fonts in the requested interval', () => {
  const project = createDefaultProject(); project.fonts = [imported];
  const lyrics = makeLayer('lyrics'); lyrics.params.fontId = id;
  const title = makeLayer('title'); title.params.fontId = BUILTIN_FONTS[0].id;
  const hidden = makeLayer('lyrics'); hidden.params.fontId = 'not-required'; hidden.visible = false;
  const later = makeLayer('title'); later.params.fontId = 'not-required'; later.start = 15;
  const transparent = makeLayer('lyrics'); transparent.params.fontId = 'not-required'; transparent.opacity = 0;
  project.layers = [lyrics, title, hidden, later, transparent];
  assert.deepEqual(collectProjectFonts(project, { start: 0, end: 10 }).map(font => font.id), [id, BUILTIN_FONTS[0].id]);
  hidden.visible = true;
  assert.throws(() => collectProjectFonts(project, { start: 0, end: 10 }), /字体引用已丢失/);
});

test('new lyric style values are validated when a project is reopened', () => {
  const project = createDefaultProject(); const layer = makeLayer('lyrics'); project.layers = [layer];
  for (const [key, value] of Object.entries({ inactiveOpacity: 1.1, activeStrokeWidth: -2, lineGap: -1, translationGap: 301, transitionDuration: 0, activeShadowBlur: NaN, activeShadowEnabled: 'yes', transition: 'unknown' })) {
    const invalid = structuredClone(project); invalid.layers[0].params[key] = value;
    assert.throws(() => validateProject(invalid), `${key}=${value} should be rejected`);
  }
  layer.params = { ...layer.params, inactiveOpacity: .3, inactiveFontSize: 32, activeStrokeWidth: 4, activeShadowEnabled: false, lineGap: 60, translationGap: 25, transition: 'fade-up', transitionDuration: .6 };
  const restored=validateProject(project).layers[0];
  assert.deepEqual(restored.params,{...layer.params,transition:'none'});
  assert.equal(restored.effects!.at(-1)!.type,'fade');
  assert.equal(restored.effects!.at(-1)!.params.style,1);assert.equal(restored.effects!.at(-1)!.params.timing,1);
  assert.equal(restored.effects!.at(-1)!.params.fadeIn,.6);assert.equal(restored.effects!.at(-1)!.params.fadeOut,.6);
});

test('font upload rejects invalid containers and out-of-bounds sfnt tables', () => {
  assert.throws(() => inspectFontBuffer(Buffer.from('this is an image or arbitrary text, not a font')), /TTF、OTF/);
  const invalid = Buffer.alloc(64); invalid.writeUInt32BE(0x00010000, 0); invalid.writeUInt16BE(1, 4); invalid.writeUInt32BE(100, 20); invalid.writeUInt32BE(40, 24);
  assert.throws(() => inspectFontBuffer(invalid), /无效数据表/);
  const woff = Buffer.alloc(64); woff.write('wOFF'); woff.writeUInt32BE(1024, 8); woff.writeUInt16BE(1, 12); woff.writeUInt32BE(100, 16);
  assert.throws(() => inspectFontBuffer(woff), /WOFF/);
});

test('all bundled offline fonts are valid full sfnt files with retained OFL licenses', () => {
  const sources = JSON.parse(readFileSync('public/fonts/sources.json', 'utf8')) as { file: string; sha256: string; licenseSha256: string }[];
  for (const font of BUILTIN_FONTS) {
    const filename = font.url.split('/').at(-1)!;
    const data = readFileSync(`public/fonts/${filename}`);
    const license = readFileSync(`public/fonts/${filename.replace(/\.ttf$/, '')}-OFL.txt`);
    assert.equal(inspectFontBuffer(data).contentType, 'font/ttf');
    assert.match(license.toString('utf8'), /SIL OPEN FONT LICENSE/);
    const source = sources.find(item => item.file === filename);
    assert.ok(source, `${filename}: fixed official source is recorded`);
    assert.equal(createHash('sha256').update(data).digest('hex'), source.sha256, `${filename}: complete official font is unchanged`);
    assert.equal(createHash('sha256').update(license).digest('hex'), source.licenseSha256, `${filename}: original license is unchanged`);
  }
});

// Inspect the actual sfnt cmap rather than accepting FontFace fallback or source metadata.
function mappedCodepoints(data: Buffer): Set<number> {
  let cmap = -1;
  for (let index = 0; index < data.readUInt16BE(4); index++) {
    const record = 12 + index * 16;
    if (data.toString('ascii', record, record + 4) === 'cmap') cmap = data.readUInt32BE(record + 8);
  }
  assert.ok(cmap >= 0, 'font contains a cmap table');
  const mapped = new Set<number>();
  for (let index = 0; index < data.readUInt16BE(cmap + 2); index++) {
    const record = cmap + 4 + index * 8;
    const platform = data.readUInt16BE(record), encoding = data.readUInt16BE(record + 2);
    if (!(platform === 0 || (platform === 3 && [1, 10].includes(encoding)))) continue;
    const table = cmap + data.readUInt32BE(record + 4), format = data.readUInt16BE(table);
    if (format === 12) {
      for (let group = 0; group < data.readUInt32BE(table + 12); group++) {
        const offset = table + 16 + group * 12;
        const start = data.readUInt32BE(offset), end = data.readUInt32BE(offset + 4), firstGlyph = data.readUInt32BE(offset + 8);
        for (let code = start; code <= end; code++) if (firstGlyph + code - start !== 0) mapped.add(code);
      }
    } else if (format === 4) {
      const segments = data.readUInt16BE(table + 6) / 2;
      const ends = table + 14, starts = ends + segments * 2 + 2, deltas = starts + segments * 2, ranges = deltas + segments * 2;
      for (let segment = 0; segment < segments; segment++) {
        const start = data.readUInt16BE(starts + segment * 2), end = data.readUInt16BE(ends + segment * 2);
        const delta = data.readInt16BE(deltas + segment * 2), range = data.readUInt16BE(ranges + segment * 2);
        for (let code = start; code <= end && code !== 0xffff; code++) {
          const glyph = range ? data.readUInt16BE(ranges + segment * 2 + range + 2 * (code - start)) : code;
          if (glyph !== 0 && ((glyph + delta) & 0xffff) !== 0) mapped.add(code);
        }
      }
    }
  }
  return mapped;
}

test('five additional Japanese fonts retain standard kana, common kanji and lyric glyphs offline', () => {
  const ids = ['noto-sans-jp', 'noto-serif-jp', 'zen-maru-gothic', 'klee-one', 'yusei-magic'];
  const sample = [
    ...Array.from({ length: 84 }, (_, index) => String.fromCodePoint(0x3041 + index)),
    ...Array.from({ length: 86 }, (_, index) => String.fromCodePoint(0x30a1 + index)),
    ...'まだ潜む此処に抗い向き合い月光音楽歌詞再生時空夢希望未来愛心春夏秋冬風雨雪花海山川日本語漢字東京物語世界、。・「」『』ー！？ABCxyz012',
  ];
  for (const id of ids) {
    const font = BUILTIN_FONTS.find(item => item.id === id);
    assert.ok(font, `${id}: appears in the shared font picker library`);
    const mapped = mappedCodepoints(readFileSync(`public${font.url}`));
    assert.ok(mapped.size > 6000, `${id}: full Japanese font, not a small lyric subset`);
    for (const character of sample) assert.ok(mapped.has(character.codePointAt(0)!), `${id}: missing ${character}`);
    const project = createDefaultProject(), layer = makeLayer('lyrics');
    layer.params.fontId = id; project.layers = [layer];
    const reopened = validateProject(JSON.parse(JSON.stringify(project)));
    assert.equal(collectProjectFonts(reopened)[0].id, id, `${id}: saves and reopens as a built-in font`);
  }
});
