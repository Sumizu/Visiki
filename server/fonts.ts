import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataRoot } from './media';
import type { FontAsset } from '../src/types';

const MAX_FONT_BYTES = 64 * 1024 * 1024;
const MAX_DECODED_BYTES = 128 * 1024 * 1024;
interface FontRecord { asset: FontAsset; file: string; contentType: string }
const fonts = new Map<string, FontRecord>();
const registry = path.join(dataRoot, 'fonts.json');
const fontDirectory = path.join(dataRoot, 'fonts');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function inspectFontBuffer(bytes: Buffer): { extension: string; contentType: string } {
  if (bytes.length < 28 || bytes.length > MAX_FONT_BYTES) throw new Error('字体文件大小无效，支持最大 64 MB');
  const signature = bytes.toString('ascii', 0, 4);
  if (signature === 'wOFF' || signature === 'wOF2') {
    const headerSize = signature === 'wOFF' ? 44 : 48;
    const tables = bytes.readUInt16BE(12);
    if (bytes.length < headerSize || bytes.readUInt32BE(8) !== bytes.length || !tables || tables > 4096 || bytes.readUInt32BE(16) > MAX_DECODED_BYTES || bytes.readUInt32BE(16) < 12 || (signature === 'wOFF' && headerSize + tables * 20 > bytes.length)) throw new Error('WOFF 字体结构无效');
    return { extension: signature === 'wOFF' ? '.woff' : '.woff2', contentType: signature === 'wOFF' ? 'font/woff' : 'font/woff2' };
  }
  if (bytes.readUInt32BE(0) === 0x00010000 || signature === 'OTTO' || signature === 'true') {
    const tables = bytes.readUInt16BE(4);
    if (!tables || tables > 4096 || 12 + tables * 16 > bytes.length) throw new Error('TTF / OTF 字体结构无效');
    for (let i = 0; i < tables; i++) {
      const entry = 12 + i * 16;
      const offset = bytes.readUInt32BE(entry + 8); const length = bytes.readUInt32BE(entry + 12);
      if (offset < 12 + tables * 16 || offset + length > bytes.length) throw new Error('字体包含无效数据表');
    }
    return { extension: signature === 'OTTO' ? '.otf' : '.ttf', contentType: signature === 'OTTO' ? 'font/otf' : 'font/ttf' };
  }
  throw new Error('请选择有效的 TTF、OTF、WOFF 或 WOFF2 字体文件');
}
export async function initializeFonts(): Promise<void> {
  await fs.mkdir(fontDirectory, { recursive: true });
  try {
    const records: unknown = JSON.parse(await fs.readFile(registry, 'utf8'));
    if (!Array.isArray(records)) return;
    for (const record of records) {
      if (!record || record.asset?.type !== 'font' || !uuid.test(record.asset.id) || typeof record.file !== 'string' || typeof record.asset.name !== 'string') continue;
      const file = path.resolve(dataRoot, record.file);
      if (!file.startsWith(fontDirectory + path.sep) || !/\.(ttf|otf|woff2?)$/.test(file)) continue;
      const asset: FontAsset = { id: record.asset.id, name: record.asset.name, type: 'font', family: `VisikiFont_${record.asset.id.replaceAll('-', '_')}`, url: `/api/fonts/${record.asset.id}` };
      const contentType = file.endsWith('.woff2') ? 'font/woff2' : file.endsWith('.woff') ? 'font/woff' : file.endsWith('.otf') ? 'font/otf' : 'font/ttf';
      fonts.set(asset.id, { asset, file: record.file, contentType });
    }
  } catch { /* A fresh or damaged registry does not permit arbitrary file access. */ }
}
let saves = Promise.resolve();
async function persistFonts(): Promise<void> {
  saves = saves.catch(() => {}).then(async () => {
    const temporary = `${registry}.tmp`;
    await fs.writeFile(temporary, JSON.stringify([...fonts.values()], null, 2));
    await fs.rename(temporary, registry);
  });
  await saves;
}
export async function importFont(input: string, originalName: string): Promise<FontAsset> {
  const size = (await fs.stat(input)).size;
  if (size > MAX_FONT_BYTES) throw new Error('字体最大支持 64 MB');
  const bytes = await fs.readFile(input);
  const info = inspectFontBuffer(bytes); const id = randomUUID();
  const file = path.join(fontDirectory, `${id}${info.extension}`);
  await fs.writeFile(file, bytes, { flag: 'wx' });
  const name = path.basename(originalName).slice(0, 180) || `导入字体${info.extension}`;
  const asset: FontAsset = { id, name, type: 'font', family: `VisikiFont_${id.replaceAll('-', '_')}`, url: `/api/fonts/${id}` };
  fonts.set(id, { asset, file: path.relative(dataRoot, file), contentType: info.contentType });
  await persistFonts(); return asset;
}
export function getFont(id: string): FontRecord | undefined { return fonts.get(id); }
export function fontFile(record: FontRecord): string { return path.resolve(dataRoot, record.file); }
