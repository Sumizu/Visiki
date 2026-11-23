import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createVst3Catalog } from '../server/daw-vst3';

const id = '0123456789ABCDEF0123456789ABCDEF';
const result = (name: string) => ({ complete: true, plugins: [{ classId: id, name, vendor: 'Vendor', version: '1', category: 'Fx', parameters: [{ id: 2, name: 'Gain', unit: 'dB', defaultValue: .5, stepCount: 0, readOnly: false }] }] });
async function setup(t: any) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'visiki-vst3-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const first = path.join(base, 'first'), second = path.join(base, 'second');
  await fs.mkdir(first); await fs.mkdir(second);
  const bundle = path.join(first, 'A.vst3'), binDir = path.join(bundle, 'Contents', 'x86_64-win');
  await fs.mkdir(binDir, { recursive: true }); const binary = path.join(binDir, 'A.vst3'); await fs.writeFile(binary, 'one');
  const flat = path.join(second, 'B.vst3'); await fs.writeFile(flat, 'two');
  return { base, first, second, bundle, binary, flat, cacheFile: path.join(base, 'data', 'vst3.json') };
}

test('discovery, cache and resolution honor real binary fingerprints and root priority', async t => {
  const h = await setup(t); let calls = 0;
  const options = { roots: () => [h.first, h.second], cacheFile: h.cacheFile, available: () => true, scanner: async (module: string) => { calls++; return result(path.basename(module)); } };
  const catalog = createVst3Catalog(options);
  const scanned = await catalog.scan();
  assert.equal(calls, 2); assert.equal(scanned.scanning, false); assert.equal(scanned.plugins.length, 1); assert.equal(scanned.plugins[0].name, 'A.vst3');
  assert(scanned.issues.some(issue => issue.message.includes('重复')));
  assert.equal((await catalog.resolve(id))?.binaryPath, await fs.realpath(h.binary));
  await catalog.scan(); assert.equal(calls, 2);
  const restored = createVst3Catalog(options); assert.equal((await restored.status()).plugins.length, 1);
  await fs.writeFile(h.binary, 'modified binary');
  assert.equal(await restored.resolve(id), undefined);
  assert.equal((await createVst3Catalog(options).status()).plugins[0].name, 'B.vst3');
  await restored.scan(); assert.equal(calls, 3);
  assert.equal((await restored.resolve(id))?.name, 'A.vst3');
  await restored.scan(true); assert.equal(calls, 5);
});

test('failed modules are cached, force retries, and unavailable host refuses scanning', async t => {
  const h = await setup(t); let calls = 0;
  const options = { roots: () => [h.first], cacheFile: h.cacheFile, available: () => true, scanner: async () => { calls++; throw new Error('failed'); } };
  const catalog = createVst3Catalog(options);
  assert.match((await catalog.scan()).issues[0].message, /failed/);
  await catalog.scan(); assert.equal(calls, 1);
  const restored = createVst3Catalog(options); await restored.scan(); assert.equal(calls, 1);
  await restored.scan(true); assert.equal(calls, 2);
  const unavailable = createVst3Catalog({ ...options, available: () => false });
  const status = await unavailable.scan(true); assert.equal(status.available, false); assert(status.issues.some(issue => issue.message.includes('不可用'))); assert.equal(calls, 2);
});

test('concurrent scans deduplicate work and expose progress', async t => {
  const h = await setup(t); let calls = 0; let release!: () => void; let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const catalog = createVst3Catalog({ roots: () => [h.first], cacheFile: h.cacheFile, available: () => true, scanner: async () => { calls++; entered(); await gate; return result('A'); } });
  const first = catalog.scan(); await started;
  assert.equal((await catalog.status()).scanning, true);
  const second = catalog.scan(); release();
  await Promise.all([first, second]); assert.equal(calls, 1); assert.equal((await catalog.status()).scanning, false);
});

test('malformed metadata is rejected and changed module is not registered', async t => {
  const h = await setup(t);
  const catalog = createVst3Catalog({ roots: () => [h.first], cacheFile: h.cacheFile, available: () => true, scanner: async () => { await fs.writeFile(h.binary, 'new binary content'); return result('A'); } });
  const scanned = await catalog.scan(); assert.equal(scanned.plugins.length, 0); assert.match(scanned.issues[0].message, /发生变化/); assert.equal(await catalog.resolve(id), undefined);
  const invalid = createVst3Catalog({ roots: () => [h.second], cacheFile: path.join(h.base, 'other.json'), available: () => true, scanner: async () => ({ complete: true, plugins: [{ ...result('x').plugins[0], classId: '../bad' }] }) });
  assert.equal((await invalid.scan()).plugins.length, 0);
});

test('directory junction loops are visited once and changed binaries disappear from status', async t => {
  const h = await setup(t); let calls = 0;
  await fs.symlink(h.first, path.join(h.first, 'loop'), 'junction');
  await fs.symlink(h.first, path.join(h.second, 'alias'), 'junction');
  const catalog = createVst3Catalog({ roots: () => [h.first, h.second], cacheFile: h.cacheFile, available: () => true, scanner: async (module: string) => { calls++; return result(path.basename(module)); } });
  await catalog.scan(); assert.equal(calls, 2);
  await fs.writeFile(h.binary, 'a changed binary');
  assert.equal((await catalog.status()).plugins[0].name, 'B.vst3');
  await catalog.scan(); assert.equal(calls, 3);
});
