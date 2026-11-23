import type { DemoProject, FontAsset, Layer, LayerType, MediaAsset, LyricCue } from './types';
import { BUILTIN_FONTS, normalizeLyricFonts } from './fonts';
import { normalizeLyricStyles } from './lyric-style';
import { MIN_VIDEO_RATE, MAX_VIDEO_RATE } from './video-timing';
import { TEXT_TRANSITIONS, MIN_TEXT_TRANSITION_DURATION, MAX_TEXT_TRANSITION_DURATION } from './text-transition';
import { PARTICLE_PRESETS, PARTICLE_LIMITS, particleDefaults } from './particles';
import { ATMOSPHERE_KINDS, ATMOSPHERE_PRESETS, ATMOSPHERE_LIMITS, atmosphereDefaults } from './atmosphere';
import { validateAudioEffects, validateLayerEffects } from './effects';
import { migrateLegacyFade } from './effect-migration';
const supported = new Set<LayerType>(['background','image','video','disc','lyrics','spectrum','player','title','text','particles','atmosphere']);
const imageMasks = new Set(['rectangle','rounded','circle','ellipse','diamond','hexagon']);
const object = (value:unknown):value is Record<string,unknown> => !!value && typeof value==='object' && !Array.isArray(value);
const finite=(value:unknown,min:number,max:number)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;
export function validateProject(value:unknown):DemoProject {
  if(!object(value)||(value.format!=='visiki-project'&&value.format!=='echo-demo')||value.version!==1) throw new Error('请选择Visiki 保存的 .visiki.json 工程（也兼容旧 .echo.json）；规划草案不是可运行工程');
  if(!finite(value.width,320,3840)||!finite(value.height,180,3840)||!finite(value.fps,1,60)||!finite(value.duration,0.01,3600)||!finite(value.lyricsOffsetMs,-3600000,3600000)) throw new Error('工程尺寸或时间参数无效');
  if(typeof value.title!=='string'||typeof value.artist!=='string'||!Array.isArray(value.layers)||value.layers.length>100||!Array.isArray(value.lyrics)||value.lyrics.length>10000) throw new Error('工程字段无效或超出 Demo 容量');
  if(value.audioMuted!==undefined&&typeof value.audioMuted!=='boolean')throw new Error('音轨静音参数无效');
  const audioEffects=value.audioEffects===undefined?undefined:validateAudioEffects(value.audioEffects);
  const asset=(item:unknown,type:'audio'|'image'|'video'):MediaAsset|null=>{
    if(item===null)return null;
    if(!object(item)||item.type!==type||typeof item.id!=='string'||!/^[a-zA-Z0-9-]+$/.test(item.id)||typeof item.name!=='string')throw new Error('素材引用无效');
    if(type==='video') {
      if(!finite(item.duration,.001,86400)||!finite(item.width,1,16384)||!finite(item.height,1,16384)||!Number.isInteger(item.width)||!Number.isInteger(item.height)||(item.fps!==undefined&&!finite(item.fps,1,240)))throw new Error('视频素材的时长、尺寸或帧率无效');
      return {...item,url:`/api/assets/${item.id}`,posterUrl:`/api/video/${item.id}/poster`,fps:item.fps??30} as unknown as MediaAsset;
    }
    if(type==='audio'&&item.duration!==undefined&&!finite(item.duration,Number.MIN_VALUE,86400))throw new Error('音乐素材时长无效');
    return {...item,url:`/api/assets/${item.id}`} as unknown as MediaAsset;
  };
  const audio=asset(value.audio,'audio'); const cover=asset(value.cover,'image');
  if(value.images!==undefined&&(!Array.isArray(value.images)||value.images.length>1000))throw new Error('图片素材库无效或超出 Demo 容量');
  const images:MediaAsset[]=[]; const imageIds=new Set<string>();
  for(const item of (value.images??[]) as unknown[]) {
    const image=asset(item,'image');
    if(!image||imageIds.has(image.id))throw new Error('图片素材 ID 重复或无效');
    images.push(image);imageIds.add(image.id);
  }
  // Older projects contain only one cover. Keep it in the library so it can be
  // bound to an individual layer after opening, without changing its default role.
  if(cover&&!imageIds.has(cover.id)){images.unshift(cover);imageIds.add(cover.id);}
  if(value.videos!==undefined&&(!Array.isArray(value.videos)||value.videos.length>1000))throw new Error('视频素材库无效或超出 Demo 容量');
  const videos:MediaAsset[]=[]; const videoIds=new Map<string,MediaAsset>();
  for(const item of (value.videos??[]) as unknown[]) {
    const video=asset(item,'video');
    if(!video||videoIds.has(video.id)||imageIds.has(video.id)||audio?.id===video.id)throw new Error('视频素材 ID 重复或无效');
    videos.push(video);videoIds.set(video.id,video);
  }
  if(value.fonts!==undefined&&(!Array.isArray(value.fonts)||value.fonts.length>100))throw new Error('字体素材库无效或超出容量');
  const fonts:FontAsset[]=[]; const fontIds=new Set(BUILTIN_FONTS.map(font=>font.id));
  for(const item of (value.fonts??[]) as unknown[]) {
    if(!object(item)||item.type!=='font'||typeof item.id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item.id)||fontIds.has(item.id)||typeof item.name!=='string'||item.name.length>180)throw new Error('字体素材引用重复或无效');
    fonts.push({id:item.id,name:item.name,type:'font',family:`VisikiFont_${item.id.replaceAll('-','_')}`,url:`/api/fonts/${item.id}`}); fontIds.add(item.id);
  }
  const layers:Layer[]=[]; const ids=new Set<string>();
  for(const item of value.layers) {
    if(!object(item)||typeof item.id!=='string'||ids.has(item.id)||!supported.has(item.type as LayerType)||typeof item.name!=='string'||typeof item.visible!=='boolean'||typeof item.locked!=='boolean'||!object(item.params)) throw new Error('图层字段或 ID 无效');
    for(const key of ['x','y','rotation'] as const) if(!finite(item[key],-100000,100000))throw new Error('图层变换数值无效');
    if(!finite(item.width,1,20000)||!finite(item.height,1,20000)||!finite(item.opacity,0,1)||!finite(item.start,0,value.duration as number)||!finite(item.end,0,value.duration as number)||(item.end as number)<=(item.start as number))throw new Error('图层尺寸或可见区间无效');
    for(const [key,param] of Object.entries(item.params)) if(key==='__proto__'||!['string','number','boolean'].includes(typeof param)||(typeof param==='number'&&!Number.isFinite(param)))throw new Error('图层参数无效');
    const effects=item.effects===undefined?undefined:validateLayerEffects(item.effects);
    if(item.type==='spectrum') {
      for(const [key,[min,max]] of Object.entries({flowSpeed:[0,3],smoothing:[0,1],lineWidth:[.5,8],envelopeWindow:[.25,4]})) {
        if(item.params[key]!==undefined&&!finite(item.params[key],min,max))throw new Error(`频谱参数无效：${key}`);
      }
    }
    if(item.effectTimeOffset!==undefined&&!finite(item.effectTimeOffset,-7200,7200))throw new Error('轨道效果时间偏移无效');
    if(item.params.imageId!==undefined&&(typeof item.params.imageId!=='string'||(item.params.imageId!==''&&!imageIds.has(item.params.imageId))))throw new Error('图层引用的图片不在素材库中');
    if(item.params.followCover!==undefined&&typeof item.params.followCover!=='boolean')throw new Error('跟随封面开关无效');
    if(item.type==='background') {
      if(item.params.backgroundType!==undefined&&!['image','video','color'].includes(String(item.params.backgroundType)))throw new Error('背景素材类型无效');
      if(item.params.videoLoop!==undefined&&typeof item.params.videoLoop!=='boolean')throw new Error('背景视频循环开关无效');
      if(item.params.playbackRate!==undefined&&!finite(item.params.playbackRate,MIN_VIDEO_RATE,MAX_VIDEO_RATE))throw new Error('背景视频播放速度无效');
      if(item.params.reverse!==undefined&&typeof item.params.reverse!=='boolean')throw new Error('背景视频倒放开关无效');
      if(item.params.videoId!==undefined&&(typeof item.params.videoId!=='string'||(item.params.videoId!==''&&!videoIds.has(item.params.videoId))))throw new Error('背景引用的视频不在视频库中');
      if(item.params.fit!==undefined&&!['cover','contain','stretch'].includes(String(item.params.fit)))throw new Error('背景视频适配方式无效');
    }
    if(item.type==='video') {
      const video=typeof item.params.videoId==='string'?videoIds.get(item.params.videoId):undefined;
      if(!video)throw new Error('视频图层引用的素材不在视频库中');
      if(!finite(item.params.sourceIn,0,video.duration!)||!finite(item.params.sourceOut,0,video.duration!)||(item.params.sourceOut as number)<=(item.params.sourceIn as number)||!finite(item.params.playbackRate,.1,8)||typeof item.params.reverse!=='boolean'||(item.params.fit!==undefined&&!['cover','contain','stretch'].includes(String(item.params.fit))))throw new Error('视频片段的源范围、速度或倒放参数无效');
      if(item.params.chromaEnabled!==undefined&&typeof item.params.chromaEnabled!=='boolean')throw new Error('视频色键开关无效');
      if(item.params.chromaColor!==undefined&&(typeof item.params.chromaColor!=='string'||!/^#[\da-f]{6}$/i.test(item.params.chromaColor)))throw new Error('视频色键颜色需要使用六位十六进制色值');
      for(const key of ['chromaTolerance','chromaSoftness','chromaSpill'])if(item.params[key]!==undefined&&!finite(item.params[key],0,1))throw new Error(`视频色键参数无效：${key}`);
      const timelineLength=(item.end as number)-(item.start as number);
      if(timelineLength<1/(value.fps as number)-1e-7||Math.abs(timelineLength-((item.params.sourceOut as number)-(item.params.sourceIn as number))/(item.params.playbackRate as number))>.02)throw new Error('视频片段的时间线长度与源范围、速度不一致');
    }
    if(item.type==='image'&&item.params.mask!==undefined&&(typeof item.params.mask!=='string'||!imageMasks.has(item.params.mask)))throw new Error('图片蒙版形状无效');
    if(item.type==='image'&&item.params.radius!==undefined&&!finite(item.params.radius,0,100000))throw new Error('图片圆角数值无效');
    if(item.type==='image'&&item.params.shadowOpacity!==undefined&&!finite(item.params.shadowOpacity,0,1))throw new Error('图片阴影强度无效');
    if(item.type==='particles') {
      const presetValue=item.params.preset;
      if(presetValue!==undefined&&!PARTICLE_PRESETS.some(preset=>preset.value===presetValue))throw new Error('氛围粒子预设无效');
      for(const [key,[min,max]] of Object.entries(PARTICLE_LIMITS))if(item.params[key]!==undefined&&!finite(item.params[key],min,max))throw new Error(`氛围粒子参数无效：${key}`);
      for(const key of ['count','seed'])if(item.params[key]!==undefined&&!Number.isInteger(item.params[key]))throw new Error(`氛围粒子参数需要整数：${key}`);
      if(item.params.color!==undefined&&(typeof item.params.color!=='string'||!/^#[\da-f]{6}$/i.test(item.params.color)))throw new Error('氛围粒子颜色需要使用六位十六进制色值');
    }
    if(item.type==='atmosphere') {
      const kindValue=item.params.kind; const presetValue=item.params.preset;
      if(kindValue!==undefined&&!ATMOSPHERE_KINDS.some(kind=>kind.value===kindValue))throw new Error('光影氛围类型无效');
      if(presetValue!==undefined) {
        const preset=ATMOSPHERE_PRESETS.find(value=>value.value===presetValue);
        if(!preset||(kindValue!==undefined&&preset.kind!==kindValue))throw new Error('光影氛围预设无效或与类型不匹配');
      }
      if(item.params.blendMode!==undefined&&!['normal','screen','add'].includes(String(item.params.blendMode)))throw new Error('光影氛围混合方式无效');
      for(const [key,[min,max]] of Object.entries(ATMOSPHERE_LIMITS))if(item.params[key]!==undefined&&!finite(item.params[key],min,max))throw new Error(`光影氛围参数无效：${key}`);
      for(const key of ['seed','rayCount'])if(item.params[key]!==undefined&&!Number.isInteger(item.params[key]))throw new Error(`光影氛围参数需要整数：${key}`);
      for(const key of ['color','secondaryColor'])if(item.params[key]!==undefined&&(typeof item.params[key]!=='string'||!/^#[\da-f]{6}$/i.test(String(item.params[key]))))throw new Error('光影氛围颜色需要使用六位十六进制色值');
    }
    if(item.params.fontId!==undefined&&(typeof item.params.fontId!=='string'||(item.params.fontId!==''&&!fontIds.has(item.params.fontId))))throw new Error('图层引用的字体不在字体库中');
    if(item.type==='text') {
      if(typeof item.params.text!=='string'||item.params.text.length>20000)throw new Error('文本框内容无效或超出两万字限制');
      if(item.params.fontSize!==undefined&&!finite(item.params.fontSize,8,300))throw new Error('文本框字号无效');
      if(item.params.lineHeight!==undefined&&!finite(item.params.lineHeight,.5,4))throw new Error('文本框行高无效');
      if(item.params.fontWeight!==undefined&&!finite(item.params.fontWeight,100,900))throw new Error('文本框字重无效');
      for(const key of ['italic','fontWeightSynthesis'])if(item.params[key]!==undefined&&typeof item.params[key]!=='boolean')throw new Error('文本框字体样式开关无效');
      if(item.params.align!==undefined&&!['left','center','right'].includes(String(item.params.align)))throw new Error('文本框对齐方式无效');
      if(item.params.color!==undefined&&(typeof item.params.color!=='string'||item.params.color.length>100))throw new Error('文本框颜色无效');
    }
    if(item.type==='title') {
      for(const key of ['fontWeight','subtitleFontWeight'])if(item.params[key]!==undefined&&!finite(item.params[key],100,900))throw new Error('曲目信息字重无效');
      for(const key of ['italic','subtitleItalic'])if(item.params[key]!==undefined&&typeof item.params[key]!=='boolean')throw new Error('曲目信息斜体开关无效');
    }
    if(item.type==='text'||item.type==='title') {
      if(item.params.textTransition!==undefined&&(typeof item.params.textTransition!=='string'||!(TEXT_TRANSITIONS as readonly string[]).includes(item.params.textTransition)))throw new Error('标题或文字的淡入淡出效果无效');
      if(item.params.textTransitionDuration!==undefined&&!finite(item.params.textTransitionDuration,MIN_TEXT_TRANSITION_DURATION,MAX_TEXT_TRANSITION_DURATION))throw new Error('标题或文字的淡入淡出时长无效');
    }
    if(['text','title','lyrics'].includes(String(item.type))) {
      if(item.params.glowEnabled!==undefined&&typeof item.params.glowEnabled!=='boolean')throw new Error('文字发光开关无效');
      if(item.params.glowColor!==undefined&&(typeof item.params.glowColor!=='string'||!/^#[\da-f]{6}$/i.test(item.params.glowColor)))throw new Error('文字发光颜色需要使用六位十六进制色值');
      if(item.params.glowIntensity!==undefined&&!finite(item.params.glowIntensity,0,2))throw new Error('文字发光强度无效');
      if(item.params.glowRadius!==undefined&&!finite(item.params.glowRadius,0,80))throw new Error('文字发光范围无效');
    }
    if(item.type==='lyrics') {
      if(item.params.planeYaw!==undefined&&!finite(item.params.planeYaw,-75,75))throw new Error('歌词左右朝向角度无效');
      if(item.params.planePerspective!==undefined&&!finite(item.params.planePerspective,0,300))throw new Error('歌词透视强度无效');
      if(item.params.translationFontId!==undefined&&(typeof item.params.translationFontId!=='string'||(item.params.translationFontId!==''&&!fontIds.has(item.params.translationFontId))))throw new Error('歌词译文引用的字体不在字体库中');
      const numeric:Record<string,[number,number]>={fontSize:[8,300],translationSize:[8,300],inactiveFontSize:[8,300],inactiveTranslationSize:[8,300],activeOpacity:[0,1],inactiveOpacity:[0,1],lineGap:[0,600],translationGap:[0,300],transitionDuration:[.05,2]};
      for(const state of ['active','inactive']) {
        numeric[`${state}FontWeight`]=[100,900];numeric[`${state}TranslationFontWeight`]=[100,900];
        for(const key of [`${state}Italic`,`${state}TranslationItalic`])if(item.params[key]!==undefined&&typeof item.params[key]!=='boolean')throw new Error('歌词斜体开关无效');
        numeric[`${state}StrokeWidth`]=[0,30];numeric[`${state}ShadowOpacity`]=[0,1];numeric[`${state}ShadowBlur`]=[0,100];numeric[`${state}ShadowX`]=[-100,100];numeric[`${state}ShadowY`]=[-100,100];
        if(item.params[`${state}ShadowEnabled`]!==undefined&&typeof item.params[`${state}ShadowEnabled`]!=='boolean')throw new Error('歌词阴影开关无效');
      }
      for(const [key,[min,max]] of Object.entries(numeric))if(item.params[key]!==undefined&&!finite(item.params[key],min,max))throw new Error(`歌词样式参数无效：${key}`);
      if(item.params.transition!==undefined&&!['none','fade','fade-up','fade-down','fade-zoom'].includes(String(item.params.transition)))throw new Error('歌词过渡效果无效');
      for(const key of ['inactiveColor','inactiveTranslationColor','activeStrokeColor','inactiveStrokeColor','activeShadowColor','inactiveShadowColor'])if(item.params[key]!==undefined&&(typeof item.params[key]!=='string'||(item.params[key] as string).length>100))throw new Error('歌词样式颜色无效');
      for(const key of ['activeShadowColor','inactiveShadowColor'])if(item.params[key]!==undefined&&!/^(#[\da-f]{3,4}|#[\da-f]{6}|#[\da-f]{8}|rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+(?:\s*,\s*[\d.]+)?\s*\))$/i.test(String(item.params[key])))throw new Error('歌词阴影颜色需要使用十六进制或 RGB 色值');
    }
    // Freeze the old cover into background/card bindings once. Afterwards a
    // cover replacement cannot silently change another independently chosen
    // image. Explicitly opted-in followCover layers retain their shared role.
    let params={...item.params} as Layer['params'];
    if((item.type==='background'||item.type==='image')&&!params.imageId&&params.followCover===undefined&&cover)params.imageId=cover.id;
    if(item.type==='lyrics')params=normalizeLyricFonts(normalizeLyricStyles(params));
    if(item.type==='particles')params={...particleDefaults(PARTICLE_PRESETS.find(preset=>preset.value===params.preset)?.value),...params};
    if(item.type==='atmosphere') {
      const kind=ATMOSPHERE_KINDS.find(value=>value.value===params.kind)?.value??ATMOSPHERE_PRESETS.find(value=>value.value===params.preset)?.kind;
      params={...atmosphereDefaults(kind,typeof params.preset==='string'?params.preset:undefined),...params};
      if(effects?.some(effect=>effect.type==='fade')) {
        if(item.params.fadeIn===undefined)params.fadeIn=0;
        if(item.params.fadeOut===undefined)params.fadeOut=0;
      }
    }
    ids.add(item.id);layers.push(migrateLegacyFade({...item,params,...(effects===undefined?{}:{effects})} as unknown as Layer));
  }
  const lyrics:LyricCue[]=[];
  for(const cue of value.lyrics) {
    if(!object(cue)||!finite(cue.time,-3600,7200)||typeof cue.text!=='string'||cue.text.length>10000||(cue.translation!==undefined&&typeof cue.translation!=='string')||(cue.end!==undefined&&(!finite(cue.end,-3600,7200)||(cue.end as number)<(cue.time as number))))throw new Error('歌词数据无效');
    lyrics.push(cue as unknown as LyricCue);
  }
  return {...value,format:'visiki-project',layers,lyrics:lyrics.sort((a,b)=>a.time-b.time),audio,cover,images,videos,fonts,audioMuted:value.audioMuted??false,...(audioEffects===undefined?{}:{audioEffects})} as unknown as DemoProject;
}
