import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sfntWeightDescriptor } from '../src/font-axis';
import { BUILTIN_FONTS, fontFamilyForId, loadFont } from '../src/fonts';
import type { FontAsset } from '../src/types';

type Axis = { tag: string; min: number; initial: number; max: number };
function variableFont(axes: Axis[], signature = 0x00010000): ArrayBuffer {
  const size = 16 + axes.length * 20;
  const data = new ArrayBuffer(28 + size); const view = new DataView(data);
  const tag = (position: number, value: string): void => { for (let index = 0; index < 4; index++) view.setUint8(position + index, value.charCodeAt(index)); };
  view.setUint32(0, signature); view.setUint16(4, 1); tag(12, 'fvar'); view.setUint32(20, 28); view.setUint32(24, size);
  view.setUint16(28, 1); view.setUint16(32, 16); view.setUint16(34, 2); view.setUint16(36, axes.length); view.setUint16(38, 20);
  axes.forEach((axis, index) => {
    const offset = 44 + index * 20; tag(offset, axis.tag);
    view.setInt32(offset + 4, axis.min * 65536); view.setInt32(offset + 8, axis.initial * 65536); view.setInt32(offset + 12, axis.max * 65536);
  });
  return data;
}
const weight: Axis = { tag: 'wght', min: 100, initial: 400, max: 900 };
const fullFile = (path: string): ArrayBuffer => new Uint8Array(readFileSync(path)).buffer;

test('complete TrueType and CFF sfnt weight axes register their actual numeric ranges', () => {
  assert.equal(sfntWeightDescriptor(variableFont([weight])), '100 900');
  assert.equal(sfntWeightDescriptor(variableFont([{ tag: 'wdth', min: 50, initial: 100, max: 200 }, { ...weight, min: 200 }], 0x4f54544f)), '200 900');
  assert.equal(sfntWeightDescriptor(variableFont([{ ...weight, min: 123.5, max: 876.25 }])), '123.5 876.25');
  assert.equal(sfntWeightDescriptor(variableFont([{ ...weight, min: 500, initial: 500, max: 500 }])), '500');
  assert.equal(sfntWeightDescriptor(fullFile('public/fonts/NotoSansJP.ttf')), '100 900');
  assert.equal(sfntWeightDescriptor(fullFile('public/fonts/NotoSerifSC.ttf')), '200 900');
  assert.equal(sfntWeightDescriptor(fullFile('public/fonts/KleeOne-Regular.ttf')), '400');
});

test('invalid or unsupported variable-font tables safely retain the legacy single-weight registration', () => {
  const corrupted = (edit: (view: DataView) => void): ArrayBuffer => { const data = variableFont([weight]); edit(new DataView(data)); return data; };
  const cases = [
    new ArrayBuffer(0), new ArrayBuffer(11), variableFont([weight], 0x774f4632), variableFont([weight], 0x774f4646), variableFont([weight], 0x74746366),
    variableFont([{ tag: 'wdth', min: 50, initial: 100, max: 200 }]), variableFont([weight, weight]),
    variableFont([{ ...weight, min: -1 }]), variableFont([{ ...weight, max: 1001 }]), variableFont([{ ...weight, min: 500 }]), variableFont([{ ...weight, max: 300 }]),
    corrupted(view => view.setUint16(4, 500)), corrupted(view => view.setUint32(20, 0xfffffff0)), corrupted(view => view.setUint32(24, 0xfffffff0)),
    corrupted(view => view.setUint16(28, 2)), corrupted(view => view.setUint16(30, 1)), corrupted(view => view.setUint16(32, 1)),
    corrupted(view => view.setUint16(36, 2)), corrupted(view => view.setUint16(38, 19)),
  ];
  for (const data of cases) assert.equal(sfntWeightDescriptor(data), '400');
  for (let length = 0; length < 96; length++) {
    const data = new Uint8Array(length).fill(255).buffer;
    assert.equal(sfntWeightDescriptor(data), '400', 'untrusted import bytes must not throw during font preparation');
  }
});

test('font loading detects imported weight ranges while keeping built-in descriptors and 400 fallbacks', async () => {
  const scope = globalThis as unknown as Record<string, unknown>;
  const original = new Map(['FontFace', 'document', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(scope, key)]));
  const descriptors: { family: string; weight: string | undefined }[] = []; const registered: unknown[] = [];
  const variableId = 'test-variable-axis'; const staticId = 'test-static-axis';
  class Face {
    constructor(family: string, _source: unknown, options: FontFaceDescriptors) { descriptors.push({ family, weight: options.weight }); }
    async load() { return this; }
  }
  const asset = (id: string): FontAsset => ({ id, name: `${id}.ttf`, family: id, url: '/untrusted-url', type: 'font' });
  try {
    scope.FontFace = Face; scope.document = { fonts: { add: (face: unknown) => registered.push(face) } };
    scope.fetch = async (url: string) => new Response(url === `/api/fonts/${variableId}` ? variableFont([weight]) : new ArrayBuffer(12));
    await loadFont(asset(variableId)); await loadFont(asset(staticId)); await loadFont(BUILTIN_FONTS.find(font => font.id === 'noto-serif-jp')!);
    assert.deepEqual(descriptors.map(item => item.weight), ['400', '100 900', '400', '200 900']);
    assert.deepEqual(descriptors.slice(0, 2).map(item => item.family), ['VisikiFont_test_variable_axis', 'VisikiFont_test_variable_axis_Variable']);
    assert.match(fontFamilyForId(variableId), /^"VisikiFont_test_variable_axis",/);
    assert.match(fontFamilyForId(variableId, true), /^"VisikiFont_test_variable_axis_Variable",/);
    assert.match(fontFamilyForId(staticId, true), /^"VisikiFont_test_static_axis",/);
    assert.match(fontFamilyForId('noto-serif-jp', true), /^"VisikiFont_noto_serif_jp",/);
    assert.equal(registered.length, 4);
    await loadFont(asset(variableId)); assert.equal(registered.length, 4, 'the loaded font remains cached without duplicate registrations');
  } finally {
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(scope, key, descriptor); else delete scope[key];
    }
  }
});
