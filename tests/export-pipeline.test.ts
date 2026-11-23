import test from 'node:test';
import assert from 'node:assert/strict';
import { exportBatchSize, runExportPipeline } from '../src/export-pipeline';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test('export pipeline overlaps only one next batch and preserves upload order and the final partial batch', async () => {
  const rendered: [number,number][] = [], uploaded: [number,number][] = [], progress: number[] = [];
  const gate = deferred(); let active = 0, maximum = 0;
  const done = runExportPipeline(9,4,async (start,count) => { rendered.push([start,count]); return start; }, async (start,count,data) => {
    assert.equal(data,start); maximum=Math.max(maximum,++active); uploaded.push([start,count]); if(start===0) await gate.promise; active--;
  },undefined,value => progress.push(value));
  await turn();
  assert.deepEqual(rendered,[[0,4],[4,4]]); assert.deepEqual(uploaded,[[0,4]]); assert.deepEqual(progress,[]);
  gate.resolve(); await done;
  assert.equal(maximum,1); assert.deepEqual(uploaded,[[0,4],[4,4],[8,1]]); assert.deepEqual(progress,[4,8,9]);
});

test('a failed upload is observed while a next batch renders and no following upload starts', async () => {
  const gate = deferred(); const failed = new Error('encoder closed'); const uploaded: number[]=[];
  const done = runExportPipeline(3,1,async start=>{if(start===1)await gate.promise;return start;},async start=>{uploaded.push(start);throw failed;});
  const rejected = assert.rejects(done,error=>error===failed);
  await turn(); gate.resolve(); await rejected; assert.deepEqual(uploaded,[0]);
});

test('cancelling a render in progress does not upload its next frame', async () => {
  const controller = new AbortController(); const gate = deferred(); const uploaded: number[]=[];
  const done = runExportPipeline(3,1,async start=>{if(start===1)await gate.promise;return start;},async start=>{uploaded.push(start);},controller.signal);
  const rejected = assert.rejects(done,error=>error instanceof DOMException&&error.name==='AbortError');
  await turn(); controller.abort(); gate.resolve(); await rejected; assert.deepEqual(uploaded,[0]);
});

test('raw batches are bounded to sixteen MiB across supported output sizes', () => {
  assert.equal(exportBatchSize(1280,720),4); assert.equal(exportBatchSize(1920,1080),2); assert.equal(exportBatchSize(1920,1920),1);
  assert.equal(exportBatchSize(1280,720,1280*720*4),1);
  for(const [w,h] of [[1280,720],[1920,1080],[1920,1920]]) assert(exportBatchSize(w,h)*w*h*4<=16*1024*1024);
  assert.throws(()=>exportBatchSize(1920,1080,1024));
});
