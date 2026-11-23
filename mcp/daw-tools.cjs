'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { Readable, Transform, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

module.exports = function dawTools(h) {
  const { string: s, number: n, integer: int, object: o, revision: rev, localPath, tool, filePath, atomicFile, checkTree, textResult } = h;
  const bool = { type: 'boolean' }, id = s(165), en = values => ({ type: 'string', enum: values }), ids = { type: 'array', maxItems: 128, items: id };
  const ref = o({ kind: en(['clip','asset']), id }, ['kind','id']);
  const range = o({ start: n(0, 3630), end: n(0, 3630) }, ['start','end']);
  const harmonyTrack = { anyOf: [{ ...id, minLength: 0 }, { type: 'null' }], description: 'Optional harmony track ID. Omit, pass null or leave empty for lead and backing only.' };
  const opts = o({ roles: o({ lead:id, harmony:harmonyTrack, backing:id }), harmony:en(['support','duet','mixed']), direction:en(['blended','natural','forward']), genre:en(['none','pop','rock','acoustic']), space:en(['unchanged','room','plate']), spaceAmount:n(0,100), handoffs:{type:'array',maxItems:64,items:range}, delivery:o({mode:en(['preserve','peak','custom']),ceilingDb:n(-12,0),targetLufs:n(-36,-8)}), excludedChangeIds:ids });
  const attach = { assetId:id, placement:en(['new_track','existing_track','library']), trackId:id, start:n(0,3600), name:s(240), expectedRevision:rev };
  const definitions = [
    ['status','Check DAW connection and capability.',o(),true],
    ['activate','Activate DAW and wait for hydration.',o({expectedRevision:rev})],
    ['catalog','Read supported operations, effect types, and limits. Set vst3=true to browse compatible scanned plugins; use classId or effectId for parameter details, query to filter, offset/limit to paginate, and includeChoices to include choices.',o({effectType:id,vst3:bool,classId:id,effectId:id,query:s(240),offset:int(0,Number.MAX_SAFE_INTEGER),limit:int(1,128),includeChoices:bool}),true],
    ['scan_vst3','Start a background scan of standard VST3 locations. Use force=true to rescan every module. Poll catalog with vst3=true until scanning is false.',o({force:bool})],
    ['get_session','Read the DAW session and revision.',o(),true],
    ['new_session','Create a new session.',o({name:s(240),expectedRevision:rev})],
    ['open_session','Read an absolute local .visiki-daw.json file and replace the session.',o({path:localPath,expectedRevision:rev},['path']),false,true],
    ['save_session','Save the current session as .visiki-daw.json without embedding audio.',o({path:localPath,overwrite:bool},['path']),false,true],
    ['list_assets','List registered audio asset summaries.',o({ids:{type:'array',maxItems:64,items:id}}),true],
    ['import_audio','Import local audio and attach it; reports the asset if attachment fails.',o({path:localPath,...Object.fromEntries(Object.entries(attach).filter(([k])=>k!=='assetId'))},['path'])],
    ['attach_asset','Attach a registered asset.',o(attach,['assetId'])],
    ['edit',"Apply one atomic undoable batch. Consult catalog for operation fields; results may be referenced as $0.trackId, $1.clipId, etc. VST3 operations: add_vst3 {target,classId,index?,name?,enabled?,params?,vst3Params?}; update_effect {target,effectId,params or vst3Params}. vst3Params is an array of {paramId,format:'normalized'|'plain'|'text'|'choice',value,unit?}.",o({operations:{type:'array',minItems:1,maxItems:256,items:{type:'object',properties:{op:id},required:['op']}},expectedRevision:rev},['operations'])],
    ['undo','Undo an edit.',o({expectedRevision:rev})], ['redo','Redo an edit.',o({expectedRevision:rev})],
    ['transport','Control the DAW playhead and monitoring.',o({time:n(0,3600),playing:bool,monitorDb:n(-60,0),expectedRevision:rev})],
    ['view','Change DAW selection and display.',o({selection:{anyOf:[o({trackId:id,clipId:id},['trackId']),{type:'null'}]},preferences:o({snapEnabled:bool,snapGrid:bool,snapEdges:bool,snapCursor:bool,rulerUnit:en(['time','bars']),gridDivision:en(['auto','bar','1/1','1/2','1/4','1/8','1/16','1/32','1/64']),restartMode:en(['resume','from-cursor'])}),zoom:n(4,250),fit:bool,mixerOpen:bool,panels:o({head:n(140,320),inspector:n(235,460),mixer:n(170,420)}),expectedRevision:rev})],
    ['meters','Read or reset meters.',o({effectId:id,reset:bool,expectedRevision:rev})],
    ['monitor_effect','Control comparison or noise monitoring.',o({action:en(['compare','noise','clear']),effectId:id,enabled:bool,expectedRevision:rev},['action'])],
    ['effect_presets','List, save, delete, apply or favorite effect presets.',o({action:en(['list','save','delete','apply','favorite']),effectType:id,target:id,effectId:id,presetId:id,name:s(80),favorite:bool,expectedRevision:rev},['action'])],
    ['job_start','Start a render, rhythm, auto-mix or effect analysis job. Auto-mix requires distinct lead and backing tracks; harmony is optional. Poll job_status.',o({kind:en(['render','rhythm','auto_mix','match_eq','learn_noise','compare']),includeTail:bool,assetId:id,clipId:id,start:n(0,3630),duration:n(0,90),options:opts,target:id,effectId:id,sourceTarget:id,reference:ref,position:n(0,3630),expectedRevision:rev},['kind'])],
    ['job_status','Query one job or list jobs.',o({jobId:id}),true], ['job_cancel','Cancel a background job.',o({jobId:id},['jobId'])],
    ['job_apply','Apply an analysis result.',o({jobId:id,mode:en(['balance','full']),changeIds:ids,strength:n(0,100),bpm:n(20,300),applyMeter:bool,expectedRevision:rev},['jobId'])],
    ['preview','Render 0.02 to 20 seconds of WAV. A dry clip/asset reference uses times relative to its beginning. Plan variants require jobId. Use monitorTrimDb to attenuate a louder variant for matched-level listening.',o({start:n(0,3600),end:n(0,3600),jobId:id,variant:en(['original','balance','full']),changeIds:ids,reference:ref,preview:bool,monitorTrimDb:n(-60,0),path:localPath,overwrite:bool},['start','end']),false],
    ['download_wav','Download a completed render job or a render UUID to a local WAV.',o({jobId:id,renderId:id,path:localPath,overwrite:bool},['path']),false,true],
    ['send_to_editor','Send a rendered WAV to the video editor and activate it.',o({renderId:id,expectedRevision:rev},['renderId'])]
  ];
  const tools = definitions.map(([name,description,schema,readOnly,destructive]) => tool('visiki_daw_'+name,description,schema,readOnly,destructive));
  function required(args, names) {
    for (const key of names) if (args[key] === undefined) throw new Error(`${key} is required for this action`);
  }
  async function wav(response, destination, overwrite, signal) {
    if (!response.body) throw new Error('Empty WAV response');
    const limit = destination ? 8 * 1024 ** 3 : 16 * 1024 ** 2;
    let bytes = 0;
    let header = Buffer.alloc(0);
    const source = Readable.fromWeb(response.body);
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (header.length < 12) header = Buffer.concat([header, chunk.subarray(0, 12 - header.length)]);
        if (bytes > limit) return callback(new Error('WAV exceeds transfer limit; supply path for large previews'));
        callback(null, chunk);
      }
    });
    const checkHeader = () => {
      if (header.length < 12 || !['RIFF', 'RF64'].includes(header.toString('ascii', 0, 4)) || header.toString('ascii', 8, 12) !== 'WAVE') {
        throw new Error('Invalid WAV content');
      }
    };
    if (destination) {
      await atomicFile(destination, overwrite, async temporary => {
        await pipeline(source, counter, fs.createWriteStream(temporary, { flags: 'wx' }), { signal });
        checkHeader();
      }, signal);
      return { bytes, path: destination };
    }
    const chunks = [];
    const sink = new Writable({
      write(chunk, _encoding, callback) { chunks.push(chunk); callback(); }
    });
    await pipeline(source, counter, sink, { signal });
    checkHeader();
    return { bytes, data: Buffer.concat(chunks).toString('base64') };
  }
  function headerNumber(response, name) {
    const value = response.headers.get(name);
    if (value === null || value.trim() === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  const jsonPost = data => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  async function execute(name, args, request, signal) {
    const { expectedRevision, ...data } = args;
    const command = async (type, args, revision = expectedRevision) => {
      const response = await request('/api/agent/daw/commands', jsonPost({ type, args, expectedRevision: revision }));
      if (!response || typeof response !== 'object' || !('result' in response)) throw new Error('Invalid DAW command result');
      return response.result;
    };
    const op = name.slice('visiki_daw_'.length);
    let result;
    switch (op) {
      case 'status': result = await request('/api/agent/daw/status'); break;
      case 'scan_vst3': result = await request('/api/daw/vst3/scan', jsonPost({ force: args.force, background: true })); break;
      case 'list_assets': {
        const query = new URLSearchParams({ summary: '1' });
        if (args.ids) query.set('ids', args.ids.join(','));
        result = await request(`/api/daw/assets?${query}`);
        break;
      }
      case 'open_session': {
        const filename = filePath(args.path, '.visiki-daw.json');
        const stat = await fsp.stat(filename);
        if (!stat.isFile() || stat.size > 24 * 1024 ** 2) throw new Error('Session must be a regular file no larger than 24 MiB');
        const session = JSON.parse((await fsp.readFile(filename, { encoding: 'utf8', signal })).replace(/^\uFEFF/, ''));
        checkTree(session);
        result = await command('replace_session', { session });
        break;
      }
      case 'save_session': {
        const destination = filePath(args.path, '.visiki-daw.json');
        const { session, revision } = await command('get_session');
        if (!session || typeof session !== 'object') throw new Error('Invalid session snapshot');
        await atomicFile(destination, !!args.overwrite,
          temporary => fsp.writeFile(temporary, JSON.stringify(session, null, 2) + '\n', { flag: 'wx', signal }), signal);
        result = { path: destination, revision };
        break;
      }
      case 'import_audio': {
        const filename = filePath(args.path);
        const stat = await fsp.stat(filename);
        if (!stat.isFile() || stat.size === 0 || stat.size > 512 * 1024 ** 2) throw new Error('Audio must be a non-empty regular file no larger than 512 MiB');
        const form = new FormData();
        form.set('file', await fs.openAsBlob(filename), path.basename(filename));
        const asset = await request('/api/daw/assets?summary=1', { method: 'POST', body: form });
        if (typeof asset?.id !== 'string') throw new Error('Invalid imported audio asset');
        const { path: _path, ...placement } = data;
        try {
          result = { asset, attachment: await command('attach_asset', { ...placement, assetId: asset.id,
            placement: placement.placement ?? (placement.trackId ? 'existing_track' : 'new_track') }) };
        } catch (error) {
          return { isError: true, ...textResult({
            error: 'Audio imported but attachment failed; use visiki_daw_attach_asset with this asset ID instead of uploading again.',
            detail: error.message, importedAsset: asset
          }) };
        }
        break;
      }
      case 'attach_asset':
        result = await command(op, { ...data, placement: data.placement ?? (data.trackId ? 'existing_track' : 'new_track') });
        break;
      case 'preview': {
        if (args.reference && (args.jobId || args.variant || args.changeIds)) throw new Error('Reference previews cannot use plan variants');
        if (args.end - args.start < .02 - 1e-9 || args.end - args.start > 20 + 1e-9) throw new Error('Preview duration must be 0.02 to 20 seconds');
        const { path: filename, overwrite, monitorTrimDb, ...source } = data;
        const destination = filename ? filePath(filename, '.wav') : undefined;
        const snapshot = await command('preview_source', source);
        if (!snapshot?.session || !snapshot?.range) throw new Error('Invalid preview source');
        const response = await request('/api/daw/auto-mix/preview', jsonPost({
          session: snapshot.session, range: snapshot.range, preview: snapshot.preview, monitorTrimDb
        }), true);
        const metadata = { revision: snapshot.revision, range: snapshot.range, monitorTrimDb: monitorTrimDb ?? 0,
          lufs: headerNumber(response, 'x-visiki-lufs'), truePeak: headerNumber(response, 'x-visiki-true-peak') };
        const { data: audio, ...file } = await wav(response, destination, !!overwrite, signal);
        const description = textResult({ ...metadata, ...file });
        if (audio) description.content.unshift({ type: 'audio', mimeType: 'audio/wav', data: audio });
        return description;
      }
      case 'download_wav': {
        if (!!args.jobId === !!args.renderId) throw new Error('Provide exactly one of jobId or renderId');
        const destination = filePath(args.path, '.wav');
        let renderId = args.renderId;
        if (args.jobId) {
          const job = await command('job_status', { jobId: args.jobId });
          if (job?.state !== 'complete' || job.kind !== 'render') throw new Error('Render job is not complete');
          renderId = job.result?.id;
        }
        if (typeof renderId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(renderId)) {
          throw new Error('Invalid render UUID');
        }
        const response = await request(`/api/daw/renders/${renderId}`, {}, true);
        const file = await wav(response, destination, !!args.overwrite, signal);
        result = { ...file, renderId, ...(args.jobId ? { jobId: args.jobId } : {}) };
        break;
      }
      case 'effect_presets': {
        const fields = { save: ['target', 'effectId', 'name'], apply: ['target', 'effectId', 'presetId'],
          delete: ['presetId'], favorite: ['effectType', 'favorite'], list: [] };
        required(args, fields[args.action]);
        result = await command(op, data);
        break;
      }
      case 'monitor_effect':
        if (args.action !== 'clear') required(args, ['effectId']);
        result = await command(op, data);
        break;
      case 'job_start': {
        const fields = { match_eq: ['target', 'effectId', 'reference'], learn_noise: ['target', 'effectId', 'start', 'duration'], compare: ['effectId', 'position'] };
        required(args, fields[args.kind] ?? []);
        if (args.kind === 'rhythm' && !!args.assetId === !!args.clipId) throw new Error('Rhythm requires exactly one assetId or clipId');
        result = await command(op, data);
        break;
      }
      default: result = await command(op, data); break;
    }
    return textResult(result);
  }
  return {tools,execute};
};
