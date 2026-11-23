/** Read only the OpenType weight axis from a complete sfnt font. Unsupported
 * containers (collections/WOFF/WOFF2) and malformed tables keep the existing
 * single-face registration; no font parser or decompressor is needed. */
export function sfntWeightDescriptor(buffer: ArrayBuffer): string {
  const fallback = '400';
  const view = new DataView(buffer);
  if (view.byteLength < 12) return fallback;
  const signature = view.getUint32(0);
  if (signature !== 0x00010000 && signature !== 0x4f54544f && signature !== 0x74727565) return fallback;
  const tableCount = view.getUint16(4);
  if (!tableCount || 12 + tableCount * 16 > view.byteLength) return fallback;
  let tableOffset = -1; let tableLength = 0;
  for (let index = 0; index < tableCount; index++) {
    const entry = 12 + index * 16;
    if (view.getUint32(entry) !== 0x66766172) continue; // fvar
    if (tableOffset !== -1) return fallback;
    tableOffset = view.getUint32(entry + 8); tableLength = view.getUint32(entry + 12);
  }
  if (tableOffset < 0 || tableLength < 16 || tableOffset + tableLength > view.byteLength) return fallback;
  const end = tableOffset + tableLength;
  if (view.getUint16(tableOffset) !== 1 || view.getUint16(tableOffset + 2) !== 0) return fallback;
  const axesOffset = tableOffset + view.getUint16(tableOffset + 4);
  const axisCount = view.getUint16(tableOffset + 8); const axisSize = view.getUint16(tableOffset + 10);
  if (axesOffset < tableOffset + 16 || axisSize < 20 || axesOffset + axisCount * axisSize > end) return fallback;
  let descriptor: string | undefined;
  for (let index = 0; index < axisCount; index++) {
    const axis = axesOffset + index * axisSize;
    if (view.getUint32(axis) !== 0x77676874) continue; // wght
    if (descriptor !== undefined) return fallback;
    const min = view.getInt32(axis + 4) / 65536;
    const initial = view.getInt32(axis + 8) / 65536;
    const max = view.getInt32(axis + 12) / 65536;
    // CSS/OpenType numeric weight is 1..1000. The editor control uses 100..900,
    // while the registration preserves the real face's full available range.
    if (min < 1 || max > 1000 || min > initial || initial > max) return fallback;
    descriptor = min === max ? String(min) : `${min} ${max}`;
  }
  return descriptor ?? fallback;
}
