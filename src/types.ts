export type LayerType = 'background' | 'image' | 'video' | 'disc' | 'lyrics' | 'spectrum' | 'player' | 'title' | 'text' | 'particles' | 'atmosphere';
export type LayerParams = Record<string, string | number | boolean>;
export type EffectType = 'color' | 'film' | 'rgb-split' | 'glitch' | 'crt' | 'audio-reactive' | 'fade';
export interface LayerEffect { id: string; type: EffectType; enabled: boolean; strength: number; params: LayerParams }
export interface Layer {
  id: string; type: LayerType; name: string;
  x: number; y: number; width: number; height: number; rotation: number; opacity: number;
  visible: boolean; locked: boolean; start: number; end: number; params: LayerParams; effects?: LayerEffect[];
  effectTimeOffset?: number;
}
export interface MediaAsset {
  id: string; name: string; type: 'audio' | 'image' | 'video'; url: string;
  duration?: number; sampleRate?: number; channels?: number; sampleCount?: number;
  width?: number; height?: number; fps?: number; posterUrl?: string;
}
export interface FontAsset {
  id: string; name: string; type: 'font'; family: string; url: string;
  builtin?: boolean; license?: string; weight?: string;
}
export interface LyricCue { time: number; end?: number; text: string; translation?: string }
export interface DemoProject {
  format: 'visiki-project' | 'echo-demo'; version: 1; width: number; height: number; fps: number; duration: number;
  title: string; artist: string; audio: MediaAsset | null; cover: MediaAsset | null;
  images?: MediaAsset[]; videos?: MediaAsset[]; audioMuted?: boolean; audioEffects?: LayerEffect[];
  fonts?: FontAsset[];
  lyrics: LyricCue[]; lyricsOffsetMs: number; layers: Layer[];
  lyricsSource?: { provider: string; id: string; url: string };
}
export interface AudioAnalysis {
  hopSec: number; bands: number; frames: Float32Array[]; peaks: Float32Array;
  waveform: Float32Array; sampleRate: number; duration: number;
}
export interface SceneResources {
  cover: CanvasImageSource | null; analysis: AudioAnalysis | null;
  images?: Map<string, CanvasImageSource>;
  videos?: Map<string, CanvasImageSource>;
}
export interface RenderOptions { editor?: boolean; selectionId?: string | null }
export interface SongResult {
  id: string; title: string; artists: string[]; album: string; durationMs: number;
  coverUrl?: string; provider: 'netease' | 'qq';
}
export interface LyricsResult {
  id: string; title?: string; artists?: string[]; originalLrc: string; translatedLrc: string;
  romanizedLrc?: string; sourceUrl: string; provider: 'netease' | 'qq';
}
export interface ExportSettings { width: number; height: number; fps: number; start: number; end: number }
export interface ExportProgress { jobId: string; state: 'rendering' | 'encoding' | 'complete' | 'cancelled' | 'error'; completed: number; total: number; message?: string; downloadUrl?: string; elapsedMs?: number; framesPerSecond?: number }
