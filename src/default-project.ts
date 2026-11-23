import type { DemoProject, Layer, LayerType } from './types';
import { normalizeLyricStyles } from './lyric-style';
import { normalizeLyricFonts } from './fonts';
import { particleDefaults } from './particles';
import { atmosphereDefaults } from './atmosphere';
import { migrateLegacyFade } from './effect-migration';
export function makeLayer(type: LayerType, duration = 30): Layer {
  const shared = { id: crypto.randomUUID(), type, rotation: 0, opacity: 1, visible: true, locked: false, start: 0, end: duration };
  switch (type) {
    case 'background': return { ...shared, name: '氛围背景', x: 960, y: 540, width: 1920, height: 1080, locked: true, params: { backgroundType: 'image', videoId: '', videoLoop: true, playbackRate: 1, reverse: false, imageId: '', followCover: false, color: '#33303f', blur: 40, brightness: 0.48 } };
    case 'image': return { ...shared, name: '封面卡片', x: 506, y: 501, width: 620, height: 826, params: { imageId: '', followCover: false, fit: 'cover', mask: 'rounded', radius: 2, shadow: true, shadowOpacity: 160 / 255 } };
    case 'video': return { ...shared, name: '视频片段', x: 960, y: 540, width: 1280, height: 720, params: { videoId: '', sourceIn: 0, sourceOut: duration, playbackRate: 1, reverse: false, fit: 'stretch' } };
    case 'disc': return { ...shared, name: '黑胶唱片', x: 1410, y: 390, width: 580, height: 580, params: { skin: 'vinyl', rpm: 8, tonearm: true, labelRatio: 0.48 } };
    case 'lyrics': return { ...shared, name: '双语歌词', x: 1390, y: 805, width: 900, height: 190, params: normalizeLyricFonts(normalizeLyricStyles({ fontSize: 43, translationSize: 36, color: '#ffffff', translationColor: '#e5e2f0', mode: 'scroll', lines: 3, align: 'center' })) };
    case 'spectrum': return { ...shared, name: '音乐频谱', x: 580, y: 997, width: 1030, height: 100, params: { mode: 'bars', color: '#e6d9f5', gain: 1.3, barCount: 80 } };
    case 'player': return { ...shared, name: '播放器装饰', x: 1410, y: 979, width: 670, height: 115, params: { color: '#ffffff', progress: true, time: true } };
    case 'title': return { ...shared, name: '曲目信息', x: 510, y: 936, width: 650, height: 65, params: { fontSize: 26, color: '#eeebf5', textTransition: 'none', textTransitionDuration: .5 } };
    case 'text': return { ...shared, name: '文本框', x: 960, y: 540, width: 800, height: 240, params: { text: '输入你的文字', fontId: '', fontSize: 48, color: '#ffffff', align: 'left', lineHeight: 1.3, fontWeight: 400, textTransition: 'none', textTransitionDuration: .5 } };
    case 'particles': return { ...shared, name: '氛围粒子', x: 960, y: 540, width: 1920, height: 1080, params: particleDefaults() };
    case 'atmosphere': return migrateLegacyFade({ ...shared, name: '光影氛围', x: 960, y: 540, width: 1920, height: 1080, params: atmosphereDefaults() });
  }
}
export function createDefaultProject(): DemoProject {
  return { format: 'visiki-project', version: 1, width: 1920, height: 1080, fps: 30, duration: 30,
    title: '月光之间', artist: 'Visiki STUDIO · 原创合成演示', audio: null, cover: null, images: [], videos: [], fonts: [], audioMuted: false, lyricsOffsetMs: 0,
    lyrics: [
      { time: 0, text: '让旋律，成为看得见的风景', translation: 'Turn your music into a moving story' },
      { time: 5, text: '光落在唱片，时间开始旋转', translation: 'A little light, a world in motion' },
      { time: 10, text: '把此刻的心情，写进每一句', translation: 'Every line carries a feeling' },
      { time: 15, text: '让声音，在画面里流动', translation: 'Let the sound flow through the frame' },
      { time: 20, text: '下一段故事，由你来续写', translation: 'The next verse is yours to create' },
      { time: 25, end: 30, text: '听见自己，也看见音乐', translation: 'Make something that sounds like you' }
    ], layers: (['background','image','disc','title','lyrics','spectrum','player'] as LayerType[]).map(t => makeLayer(t)) };
}
