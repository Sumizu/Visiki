import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { assetFile, dataRoot, getAsset, getDemoAudio, importAudio, importImage, importVideo, initializeMedia, runFFmpeg, videoPosterFile } from './media';
import { cancelExport, createExportJob, finishExport, getExportJob, killExports, writeFrame, writeFrames } from './export';
import { MAX_FRAME_BATCH_BYTES } from './export-frames';
import { fetchSongLyrics, searchSongs } from './lyrics-provider';
import { fontFile, getFont, importFont, initializeFonts } from './fonts';
import { installAgentControl } from './agent-control';
import { dawRouter, initializeDaw, killDawJobs } from './daw';

const port=Number(process.env.PORT || 4317);
const app=express();
app.disable('x-powered-by');
app.use((req,res,next)=>{
  const origin=req.headers.origin;
  if(origin && ![`http://127.0.0.1:${port}`,'http://127.0.0.1:5173',`http://localhost:${port}`,'http://localhost:5173'].includes(origin)) { res.status(403).json({error:'仅允许本地编辑器访问'}); return; }
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Cross-Origin-Resource-Policy','same-origin');
  next();
});
const dawJson = express.json({limit:'32mb'});
const editorJson = express.json({limit:'5mb'});
app.use((req,res,next) => {
  const daw = req.path === '/api/daw' || req.path.startsWith('/api/daw/') || req.path.startsWith('/api/agent/daw/');
  (daw ? dawJson : editorJson)(req,res,next);
});
const agentControl=installAgentControl(app,{port,dataRoot});
app.use('/api/daw', dawRouter);
const upload=multer({ dest:path.join(dataRoot,'uploads'),limits:{fileSize:512*1024*1024, files:1},fileFilter:(_req,file,callback)=>{
  file.originalname=Buffer.from(file.originalname,'latin1').toString('utf8'); callback(null,true);
}});
app.get('/api/health',async(_req,res)=>{
  let ffmpeg=true; try { await runFFmpeg(['-version'],5000); } catch { ffmpeg=false; }
  res.json({name:'Visiki',version:'0.1.0',ffmpeg,lyricsProvider:'netease',exportBackend:'native-ffmpeg'});
});
let demoPromise:ReturnType<typeof getDemoAudio>|undefined;
app.get('/api/demo/audio',async(_req,res)=>{
  try { demoPromise ??= getDemoAudio(); res.json(await demoPromise); }
  catch(error) { demoPromise=undefined; throw error; }
});
app.post('/api/import/:type',upload.single('file'),async(req,res)=>{
  if(!req.file) { res.status(400).json({error:'请选择文件'}); return; }
  const type=req.params.type;
  try {
    if(type==='audio') res.json(await importAudio(req.file.path,req.file.originalname));
    else if(type==='image') res.json(await importImage(req.file.path,req.file.originalname));
    else if(type==='video') res.json(await importVideo(req.file.path,req.file.originalname));
    else if(type==='font') res.json(await importFont(req.file.path,req.file.originalname));
    else res.status(400).json({error:'不支持的素材类型'});
  } finally { await fs.unlink(req.file.path).catch(()=>{}); }
});
app.get('/api/assets/:id',async(req,res)=>{
  const record=getAsset(String(req.params.id)); if(!record) { res.status(404).json({error:'素材已失联，请重新导入'}); return; }
  res.type(record.contentType); res.setHeader('Cache-Control','private, max-age=86400'); res.sendFile(assetFile(record),{dotfiles:'allow'});
});
app.get('/api/video/:id/poster',(req,res)=>{
  const record=getAsset(String(req.params.id)); const poster=record?.asset.type==='video'?videoPosterFile(record):null;
  if(!poster){res.status(404).json({error:'视频缩略图不存在'});return;}
  res.type('image/png');res.setHeader('Cache-Control','private, max-age=86400');res.sendFile(poster,{dotfiles:'allow'});
});
app.get('/api/fonts/:id',(req,res)=>{
  const record=getFont(String(req.params.id)); if(!record) {res.status(404).json({error:'字体已失联，请重新导入'});return;}
  res.type(record.contentType);res.setHeader('Cache-Control','private, max-age=86400');res.sendFile(fontFile(record),{dotfiles:'allow'});
});
app.get('/api/lyrics/search',async(req,res)=>{
  const query=String(req.query.q || '').trim(); if(!query || query.length>500) { res.status(400).json({error:'请输入歌曲名、歌手或歌曲链接（最多500字）'}); return; }
  const provider=req.query.provider==='qq'?'qq':'netease'; res.json(await searchSongs(query,provider));
});
app.get('/api/lyrics/song/:id',async(req,res)=>{
  const provider=req.query.provider==='qq'?'qq':'netease'; res.json(await fetchSongLyrics(String(req.params.id),provider));
});
app.post('/api/export/start',(req,res)=>{ res.json(createExportJob(req.body)); });
const watchFrameConnection:express.RequestHandler=(req,res,next)=>{
  const id=String(req.params.id);
  const disconnected=()=>{ if(!res.writableFinished) void cancelExport(id).catch(()=>{}); };
  req.once('aborted',disconnected); res.once('close',disconnected);
  res.once('finish',()=>{ req.off('aborted',disconnected);res.off('close',disconnected); });
  next();
};
app.post('/api/export/:id/frame/:index',watchFrameConnection,express.raw({type:'application/octet-stream',limit:'20mb'}),async(req,res)=>{
  if(!Buffer.isBuffer(req.body)) { res.status(400).json({error:'需要 RGBA 二进制帧'}); return; }
  await writeFrame(String(req.params.id),Number(req.params.index),req.body); res.json({ok:true});
});
app.post('/api/export/:id/frames/:start',watchFrameConnection,express.raw({type:'application/octet-stream',limit:MAX_FRAME_BATCH_BYTES}),async(req,res)=>{
  if(!Buffer.isBuffer(req.body)) { res.status(400).json({error:'需要 RGBA 二进制帧批次'}); return; }
  const nextFrame=await writeFrames(String(req.params.id),Number(req.params.start),req.body);
  res.json({ok:true,nextFrame});
});
app.post('/api/export/:id/finish',async(req,res)=>{ res.json(await finishExport(String(req.params.id))); });
app.post('/api/export/:id/cancel',async(req,res)=>{ await cancelExport(String(req.params.id)); res.json({ok:true}); });
app.get('/api/export/:id/download',(req,res)=>{
  const job=getExportJob(String(req.params.id)); if(!job || job.state!=='complete') { res.status(404).json({error:'视频未完成或服务已重启'}); return; }
  res.download(job.file,`Visiki-${new Date().toISOString().replaceAll(':','-').slice(0,19)}.mp4`,{dotfiles:'allow'});
});
const distRoot=path.resolve(process.cwd(),'dist');
app.use(express.static(distRoot));
app.get('/',(_req,res)=>res.sendFile(path.join(distRoot,'index.html')));
app.use((error:Error,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
  const detail=error as Error & {status?:number;code?:string};
  const status=detail.status && detail.status>=400 && detail.status<=599 ? detail.status : 400;
  console.error(error.message); if(!res.headersSent) res.status(status).json({error:error.message || '操作失败',code:detail.code});
});
let backendServer:ReturnType<typeof app.listen>|undefined;
let shuttingDown=false;
function shutdown() {
  if(shuttingDown) return;
  shuttingDown=true;
  agentControl.close(); killExports(); killDawJobs();
  // IPC is used by the Windows desktop parent: child.kill() would bypass exit
  // cleanup there. Bound shutdown even when an unfinished request owns a socket.
  const timer=setTimeout(()=>{backendServer?.closeAllConnections();process.exit(0);},1800);
  timer.unref();
  if(backendServer) backendServer.close(()=>{clearTimeout(timer);process.exit(0);});
  else {clearTimeout(timer);process.exit(0);}
}
for(const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,shutdown);
process.on('message',message=>{if(message&&typeof message==='object'&&'type' in message&&(message.type==='visiki-shutdown'||message.type==='echo-shutdown'))shutdown();});
process.on('disconnect',shutdown);
async function main() {
  await initializeMedia();
  await initializeFonts();
  await initializeDaw();
  const server=app.listen(port,'127.0.0.1');
  backendServer=server;
  await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
  try { await agentControl.initialize(); } catch(error) { server.close(); throw error; }
  console.log(`VISIKI_READY http://127.0.0.1:${port}`);if(process.send)process.send({ready:true,port});
  server.on('error',error=>{console.error(error);process.exitCode=1;});
  process.on('exit',killExports);
}
process.on('exit',()=>{agentControl.close();killDawJobs();});
void main().catch(error=>{agentControl.close();console.error(error);process.exitCode=1;});
