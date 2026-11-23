import { memo, useEffect, useRef } from 'react';
import type { DawAsset, DawClip } from './model';

/** Only the visible part gets a canvas; cached min/max data stays in source coordinates. */
export const DawWaveform = memo(function DawWaveform({ asset, clip, scale, viewStart, viewWidth, color }: {
  asset: DawAsset; clip: DawClip; scale: number; viewStart: number; viewWidth: number; color: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const left = Math.max(0, viewStart - clip.start * scale);
  const width = Math.max(0, Math.min(clip.duration * scale - left, viewStart + viewWidth - clip.start * scale - left));
  useEffect(() => {
    const element = canvas.current;
    if (!element || width <= 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const height = 55;
    element.width = Math.ceil(width * dpr); element.height = Math.ceil(height * dpr);
    const ctx = element.getContext('2d'); if (!ctx) return;
    ctx.scale(dpr, dpr); ctx.clearRect(0, 0, width, height);
    if (!asset.peaks.length || !asset.peakHopSec) {
      ctx.fillStyle = '#b7adcb'; ctx.font = '9px sans-serif'; ctx.fillText('波形未缓存 / 素材待恢复', 8, 30); return;
    }
    const channels = asset.peaks.slice(0, 2);
    const channelHeight = height / channels.length;
    const gain = 10 ** (clip.gainDb / 20);
    channels.forEach((channel, channelIndex) => {
      const middle = channelHeight * (channelIndex + .5);
      ctx.strokeStyle = color; ctx.globalAlpha = .73; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x < Math.ceil(width); x++) {
        const first = Math.max(0, Math.floor((clip.sourceIn + (left + x) / scale) / asset.peakHopSec));
        const last = Math.min(channel.min.length - 1, Math.max(first, Math.ceil((clip.sourceIn + (left + x + 1) / scale) / asset.peakHopSec)));
        let low = 0, high = 0;
        for (let bucket = first; bucket <= last; bucket++) { low = Math.min(low, channel.min[bucket] ?? 0); high = Math.max(high, channel.max[bucket] ?? 0); }
        ctx.moveTo(x + .5, middle - Math.min(1, high * gain) * channelHeight * .44);
        ctx.lineTo(x + .5, middle - Math.max(-1, low * gain) * channelHeight * .44);
      }
      ctx.stroke();
      ctx.globalAlpha = .13; ctx.beginPath(); ctx.moveTo(0, middle); ctx.lineTo(width, middle); ctx.stroke();
    });
  }, [asset, clip.sourceIn, clip.gainDb, scale, left, width, color]);
  if (width <= 0) return null;
  return <canvas ref={canvas} className="daw-waveform" aria-hidden="true" style={{ left, width, height: 55 }} />;
});
