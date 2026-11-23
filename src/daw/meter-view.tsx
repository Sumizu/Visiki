import { useCallback, useRef } from 'react';
import { advanceDawMeter, createDawMeterState, DAW_METER_FLOOR, meterDbToUnit, type DawMeterLevels, type DawMeterState } from './meter';
import './meter.css';

interface DawMeterHandle {
  id: string;
  node: HTMLDivElement;
  fill: HTMLElement;
  rms: HTMLElement;
  hold: HTMLElement;
  readout: HTMLElement;
  state: DawMeterState;
  lastReadout: number;
  vertical: boolean;
}
export type DawMeterRegistry = Set<DawMeterHandle>;
export const createDawMeterRegistry = (): DawMeterRegistry => new Set();

function paintHandle(handle: DawMeterHandle, timeMs: number, forceReadout = false): void {
  const { state, node, vertical } = handle;
  const axis = vertical ? 'scaleY' : 'scaleX';
  const peak = meterDbToUnit(state.peakDb), rms = meterDbToUnit(state.rmsDb);
  handle.fill.style.transform = `${axis}(${peak})`;
  handle.rms.style.transform = `${axis}(${rms})`;
  // Counter-scale the gradient so yellow/red remain at their dB positions.
  handle.fill.style.backgroundSize = vertical ? `100% ${100 / Math.max(.001, peak)}%` : `${100 / Math.max(.001, peak)}% 100%`;
  handle.rms.style.backgroundSize = vertical ? `100% ${100 / Math.max(.001, rms)}%` : `${100 / Math.max(.001, rms)}% 100%`;
  handle.hold.style[vertical ? 'bottom' : 'left'] = `${meterDbToUnit(state.holdDb) * 100}%`;
  handle.hold.style.opacity = state.holdDb > DAW_METER_FLOOR ? '1' : '0';
  const clipping = state.clipUntil > timeMs;
  node.classList.toggle('clipping', clipping);
  // Keep the accessible value useful without updating the accessibility tree every frame.
  if (forceReadout || timeMs - handle.lastReadout >= 150) {
    const value = state.holdDb > DAW_METER_FLOOR ? `${state.holdDb.toFixed(1)} dBFS` : '−∞ dBFS';
    handle.readout.textContent = state.holdDb > DAW_METER_FLOOR ? state.holdDb.toFixed(1) : '−∞';
    node.setAttribute('aria-valuenow', Math.min(0, state.peakDb).toFixed(1));
    node.setAttribute('aria-valuetext', clipping ? `${value}，削波` : value);
    handle.lastReadout = timeMs;
  }
}

export function paintDawMeters(registry: DawMeterRegistry, levels: DawMeterLevels, timeMs: number): void {
  for (const handle of registry) {
    handle.state = advanceDawMeter(handle.state, levels[handle.id], timeMs);
    paintHandle(handle, timeMs);
  }
}
export function resetDawMeters(registry: DawMeterRegistry): void {
  for (const handle of registry) {
    handle.state = createDawMeterState();
    paintHandle(handle, 0, true);
  }
}

export function DawMeter({ id, label, registry, orientation = 'vertical', compact = false }: {
  id: string;
  label: string;
  registry: DawMeterRegistry;
  orientation?: 'horizontal' | 'vertical';
  compact?: boolean;
}) {
  const owned = useRef<DawMeterHandle | undefined>(undefined);
  const ref = useCallback((node: HTMLDivElement | null) => {
    if (owned.current) { registry.delete(owned.current); owned.current = undefined; }
    if (!node) return;
    const handle: DawMeterHandle = {
      id, node, fill: node.querySelector('[data-meter-peak]')!, rms: node.querySelector('[data-meter-rms]')!,
      hold: node.querySelector('[data-meter-hold]')!, readout: node.querySelector('[data-meter-readout]')!,
      state: createDawMeterState(), lastReadout: -Infinity, vertical: orientation === 'vertical',
    };
    owned.current = handle; registry.add(handle); paintHandle(handle, 0, true);
  }, [registry, id, orientation]);
  return <div ref={ref} className={`daw-meter daw-meter-${orientation}${compact ? ' compact' : ''}`}
    role="meter" aria-label={label} aria-valuemin={DAW_METER_FLOOR} aria-valuemax={0} aria-valuenow={DAW_METER_FLOOR} aria-valuetext="−∞ dBFS"
    data-daw-meter={id} title={`${label} · 峰值 / RMS · dBFS`}>
    <span className="daw-meter-bar" aria-hidden="true"><i data-meter-peak className="daw-meter-peak" /><i data-meter-rms className="daw-meter-rms" /><i data-meter-hold className="daw-meter-hold" /><i className="daw-meter-clip" /></span>
    <span className="daw-meter-readout" data-meter-readout aria-hidden="true">−∞</span>
  </div>;
}
