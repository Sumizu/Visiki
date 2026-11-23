import type { DawAsset, DawClip, DawSession, DawTrack } from './model';
import { clipEnvelopeAt, sessionDuration } from './model';
import { DAW_MASTER_METER, measureDawChannels, type DawMeterLevels, type DawMeterReading } from './meter';
export { DAW_MASTER_METER } from './meter';
export type DawPlaybackRestartMode = 'resume' | 'from-cursor';

export const dbToGain = (db: number): number => 10 ** (Math.max(-96, Math.min(24, db)) / 20);
export function audibleDawTracks(session: DawSession): Set<string> {
  const hasSolo = session.tracks.some(track => track.solo);
  return new Set(session.tracks.filter(track => !track.muted && (!hasSolo || track.solo)).map(track => track.id));
}

interface MeterTap {
  splitter: ChannelSplitterNode;
  analysers: [AnalyserNode, AnalyserNode];
  samples: [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>];
}
interface TrackBus { gain: GainNode; meter: MeterTap; value: number }
interface Voice {
  key: string; trackId: string; assetId: string; element: HTMLAudioElement;
  source: MediaElementAudioSourceNode; envelope: GainNode; pan: StereoPannerNode;
  pending: boolean; removed: boolean; playing: boolean; failed: boolean;
}

/**
 * First-stage streaming audition adapter. It keeps PCM out of renderer memory.
 * The transport contract can be replaced by the planned native host; no VST or
 * built-in effect DSP is implemented here. Media seek/start is not sample-accurate.
 */
export class DawPlaybackEngine {
  private session: DawSession | undefined;
  private context: AudioContext | undefined;
  private master: GainNode | undefined;
  private monitor: GainNode | undefined;
  private masterMeter: MeterTap | undefined;
  private monitorDb = 0;
  private buses = new Map<string, TrackBus>();
  private voices = new Map<string, Voice>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private position = 0;
  private editPosition = 0;
  private playbackRestartMode: DawPlaybackRestartMode = 'resume';
  private anchorPosition = 0;
  private anchorClock = 0;
  private disposed = false;
  private playGeneration = 0;
  constructor(private readonly onError?: (message: string) => void) {}

  setSession(session: DawSession): void {
    if (this.session && this.session.id !== session.id) { this.pause(); this.seek(0); }
    this.session = session;
    this.position = Math.min(this.position, sessionDuration(session));
    this.editPosition = Math.min(this.editPosition, sessionDuration(session));
    if (this.context) this.updateBuses();
    if (this.running) this.tick();
  }
  isPlaying(): boolean { return this.running; }
  /** User-placed cursor, independent of the moving playback head. */
  getEditPosition(): number { return this.editPosition; }
  setPlaybackRestartMode(mode: DawPlaybackRestartMode): void {
    this.playbackRestartMode = mode === 'from-cursor' ? 'from-cursor' : 'resume';
  }
  getPosition(): number {
    if (!this.running || !this.context) return this.position;
    return Math.min(sessionDuration(this.session!), this.anchorPosition + Math.max(0, this.context.currentTime - this.anchorClock));
  }
  async play(time?: number): Promise<void> {
    if (this.disposed || !this.session || !this.session.tracks.some(t => t.clips.length)) return;
    const generation = ++this.playGeneration;
    this.ensureContext();
    if (time !== undefined) this.seek(time);
    else if (!this.running && this.playbackRestartMode === 'from-cursor') this.position = this.editPosition;
    await this.context!.resume();
    if (this.disposed || generation !== this.playGeneration) return;
    if (this.position >= sessionDuration(this.session)) {
      this.position = 0;
      if (this.playbackRestartMode === 'from-cursor') this.editPosition = 0;
    }
    this.anchorPosition = this.position;
    this.anchorClock = this.context!.currentTime;
    this.running = true;
    this.updateBuses();
    this.tick();
    if (!this.timer) this.timer = setInterval(() => this.tick(), 25);
  }
  pause(): void {
    ++this.playGeneration;
    this.position = this.getPosition();
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    for (const voice of this.voices.values()) this.removeVoice(voice);
    this.voices.clear();
  }
  /** User transport action; internal pauses retain their current-position semantics. */
  pauseTransport(): void {
    this.pause();
    if (this.playbackRestartMode === 'from-cursor') this.seek(this.editPosition);
  }
  seek(time: number, options?: { editPosition?: number }): void {
    if (!Number.isFinite(time)) return;
    this.position = Math.max(0, Math.min(this.session ? sessionDuration(this.session) : 0, time));
    this.editPosition = options?.editPosition !== undefined && Number.isFinite(options.editPosition)
      ? Math.max(0, Math.min(this.session ? sessionDuration(this.session) : 0, options.editPosition))
      : this.position;
    this.anchorPosition = this.position;
    this.anchorClock = this.context?.currentTime ?? 0;
    for (const voice of this.voices.values()) this.removeVoice(voice);
    this.voices.clear();
    if (this.running) this.tick();
  }
  setMonitorGain(db: number): void {
    if (!Number.isFinite(db)) return;
    this.monitorDb = Math.max(-60, Math.min(0, db));
    if (this.context && this.monitor) this.monitor.gain.setTargetAtTime(dbToGain(this.monitorDb), this.context.currentTime, .01);
  }
  getLevels(): Record<string, number> {
    const levels: Record<string, number> = {};
    if (!this.running) return levels;
    for (const [id, bus] of this.buses) levels[id] = this.readMeter(bus.meter).peak;
    return levels;
  }
  getMeterLevels(): DawMeterLevels {
    const levels: DawMeterLevels = {};
    if (!this.running) return levels;
    for (const [id, bus] of this.buses) levels[id] = this.readMeter(bus.meter);
    if (this.masterMeter) levels[DAW_MASTER_METER] = this.readMeter(this.masterMeter);
    return levels;
  }
  dispose(): void {
    this.pause(); this.disposed = true;
    for (const bus of this.buses.values()) { bus.gain.disconnect(); this.releaseMeter(bus.meter); }
    this.buses.clear(); this.master?.disconnect(); if (this.masterMeter) this.releaseMeter(this.masterMeter); this.monitor?.disconnect();
    void this.context?.close().catch(() => {});
    this.context = undefined; this.masterMeter = undefined;
  }
  private ensureContext(): void {
    if (this.context) return;
    this.context = new AudioContext({ latencyHint: 'playback' });
    this.master = this.context.createGain(); this.monitor = this.context.createGain();
    this.master.gain.value = dbToGain(this.session?.masterDb ?? 0);
    this.monitor.gain.value = dbToGain(this.monitorDb);
    this.master.connect(this.monitor); this.monitor.connect(this.context.destination);
    this.masterMeter = this.createMeter(this.master);
    this.monitor.gain.value = dbToGain(this.monitorDb);
  }
  private createMeter(input: AudioNode): MeterTap {
    const context = this.context!, splitter = context.createChannelSplitter(2);
    const analysers: MeterTap['analysers'] = [context.createAnalyser(), context.createAnalyser()];
    const samples: MeterTap['samples'] = [new Float32Array(1024), new Float32Array(1024)];
    input.connect(splitter);
    for (let channel = 0; channel < 2; channel++) {
      analysers[channel].fftSize = samples[channel].length;
      splitter.connect(analysers[channel], channel);
    }
    // Analyser outputs may remain unconnected; the listening path stays stereo and unchanged.
    return { splitter, analysers, samples };
  }
  private readMeter(meter: MeterTap): DawMeterReading {
    for (let channel = 0; channel < 2; channel++) meter.analysers[channel].getFloatTimeDomainData(meter.samples[channel]);
    return measureDawChannels(meter.samples);
  }
  private releaseMeter(meter: MeterTap): void {
    meter.splitter.disconnect();
    for (const analyser of meter.analysers) analyser.disconnect();
  }
  private updateBuses(): void {
    if (!this.context || !this.master || !this.session) return;
    const live = new Set(this.session.tracks.map(t => t.id));
    for (const [id, bus] of this.buses) if (!live.has(id)) {
      for (const [key, voice] of this.voices) if (voice.trackId === id) { this.removeVoice(voice); this.voices.delete(key); }
      bus.gain.disconnect(); this.releaseMeter(bus.meter); this.buses.delete(id);
    }
    const audible = audibleDawTracks(this.session);
    for (const track of this.session.tracks) {
      let bus = this.buses.get(track.id);
      if (!bus) {
        const gain = this.context.createGain();
        gain.gain.value = audible.has(track.id) ? dbToGain(track.volumeDb) : 0;
        gain.connect(this.master);
        bus = { gain, meter: this.createMeter(gain), value: gain.gain.value };
        this.buses.set(track.id, bus);
      }
      const value = audible.has(track.id) ? dbToGain(track.volumeDb) : 0;
      if (bus.value !== value) { bus.gain.gain.setTargetAtTime(value, this.context.currentTime, .008); bus.value = value; }
    }
    this.master.gain.setTargetAtTime(dbToGain(this.session.masterDb), this.context.currentTime, .008);
  }
  private tick(): void {
    const session = this.session, context = this.context;
    if (!this.running || !session || !context) return;
    const position = this.getPosition();
    if (position >= sessionDuration(session)) { this.pause(); return; }
    const assets = new Map(session.assets.map(asset => [asset.id, asset]));
    const audible = audibleDawTracks(session);
    const wanted = new Set<string>();
    for (const track of session.tracks) for (const clip of track.clips) {
      if (!audible.has(track.id)) continue;
      // Only active and imminently active clips own media elements and decoding resources.
      if (clip.start > position + .18 || clip.start + clip.duration <= position) continue;
      const asset = assets.get(clip.assetId); if (!asset) continue;
      const key = `${track.id}/${clip.id}`; wanted.add(key);
      let voice = this.voices.get(key);
      if (voice && voice.assetId !== asset.id) { this.removeVoice(voice); this.voices.delete(key); voice = undefined; }
      voice ??= this.createVoice(key, track, clip, asset);
      this.syncVoice(voice, track, clip, position);
    }
    for (const [key, voice] of this.voices) if (!wanted.has(key)) { this.removeVoice(voice); this.voices.delete(key); }
  }
  private createVoice(key: string, track: DawTrack, clip: DawClip, asset: DawAsset): Voice {
    const context = this.context!, element = new Audio();
    element.preload = 'auto'; element.src = asset.url;
    const source = context.createMediaElementSource(element), envelope = context.createGain(), pan = context.createStereoPanner();
    envelope.gain.value = 0;
    source.connect(envelope); envelope.connect(pan); pan.connect(this.buses.get(track.id)!.gain);
    const voice: Voice = { key, trackId: track.id, assetId: asset.id, element, source, envelope, pan, pending: false, removed: false, playing: false, failed: false };
    this.voices.set(key, voice);
    element.onloadedmetadata = () => {
      if (!voice.removed && this.running) {
        const freshTrack = this.session?.tracks.find(t => t.id === voice.trackId);
        const freshClip = freshTrack?.clips.find(c => c.id === clip.id);
        if (freshTrack && freshClip) this.syncVoice(voice, freshTrack, freshClip, this.getPosition(), true);
      }
    };
    element.onerror = () => {
      if (!voice.removed && !voice.failed) {
        voice.failed = true; this.pause();
        this.onError?.(`音轨“${asset.name}”无法试听，请检查素材是否存在并重新导入。`);
      }
    };
    element.load();
    return voice;
  }
  private syncVoice(voice: Voice, track: DawTrack, clip: DawClip, position: number, forceSeek = false): void {
    if (voice.removed || voice.failed || !this.context) return;
    const element = voice.element, local = position - clip.start;
    voice.pan.pan.setTargetAtTime(track.pan, this.context.currentTime, .008);
    if (local < 0) { if (!element.paused) element.pause(); voice.playing = false; return; }
    const target = clip.sourceIn + local;
    if (element.readyState >= 1 && (forceSeek || (!voice.pending && (!voice.playing || Math.abs(element.currentTime - target) > .12)))) {
      try { element.currentTime = Math.max(0, target); } catch { /* Retry when metadata is ready. */ }
    }
    const gain = dbToGain(clip.gainDb) * clipEnvelopeAt(clip, Math.max(0, local));
    voice.envelope.gain.setTargetAtTime(gain, this.context.currentTime, .004);
    if (!voice.pending && !voice.playing && element.readyState >= 1) {
      voice.pending = true;
      void element.play().then(() => {
        voice.pending = false;
        if (voice.removed || !this.running) element.pause(); else voice.playing = true;
      }).catch(error => {
        voice.pending = false;
        if (!voice.removed && this.running && !voice.failed) {
          voice.failed = true; this.pause();
          this.onError?.(`无法开始试听：${error instanceof Error ? error.message : String(error)}`);
        }
      });
    }
  }
  private removeVoice(voice: Voice): void {
    if (voice.removed) return;
    voice.removed = true; voice.element.onloadedmetadata = null; voice.element.onerror = null;
    voice.element.pause(); voice.element.removeAttribute('src'); voice.element.load();
    voice.source.disconnect(); voice.envelope.disconnect(); voice.pan.disconnect();
  }
}

