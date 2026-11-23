import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DawAgentJobs } from '../src/daw/agent-jobs';
import { createSession, createTrack, createClip, type DawSession } from '../src/daw/model';
import { createEffect } from '../src/daw/effects';
import type { AutoMixOptions } from '../src/daw/auto-mix';

function fixture(): DawSession {
  const session = createSession();
  const asset = { id: 'audio', name: 'Audio', url: '/api/daw/assets/audio', duration: 30, sampleRate: 48000, channels: 2, peakHopSec: .1, peaks: [{ min: [0], max: [1] }] };
  const clip = { ...createClip(asset, 0), id: 'clip', sourceIn: 4, duration: 20 };
  const track = { ...createTrack('lead'), id: 'lead', clips: [clip], effects: [{ ...createEffect('eq'), id: 'eq' }] };
  return { ...session, assets: [asset], tracks: [track] };
}
async function finished(jobs: DawAgentJobs, id: string) {
  for (let i = 0; i < 100; i++) { const job = jobs.get(id); if (job.state !== 'running') return job; await new Promise(resolve => setTimeout(resolve, 1)); }
  throw new Error('job timed out');
}
function reply(data: unknown) { return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } }); }

test('rhythm respects source-relative clip bounds and applies only to matching revision', async () => {
  const previous = globalThis.fetch; const requests: any[] = [];
  globalThis.fetch = async (_url, init) => { requests.push(JSON.parse(String(init?.body))); return reply({ bpm: 120, meter: { beatsPerBar: 3, beatUnit: 4 }, tempoCandidates: [], warnings: [] }); };
  try {
    const session = fixture(), jobs = new DawAgentJobs();
    const job = jobs.start(session, 7, { kind: 'rhythm', clipId: 'clip' });
    assert.equal((await finished(jobs, job.jobId)).state, 'complete');
    assert.deepEqual(requests[0], { assetId: 'audio', start: 4, duration: 20 });
    assert.throws(() => jobs.start(session, 7, { kind: 'rhythm', clipId: 'clip', start: 3 }), /范围/);
    assert.throws(() => jobs.start(session, 7, { kind: 'rhythm', clipId: 'clip', assetId: 'audio' }), /一个素材或片段/);
    assert.throws(() => jobs.apply(session, 8, { jobId: job.jobId }), /工程已更改/);
    const updated = jobs.apply(session, 7, { jobId: job.jobId, bpm: 121, applyMeter: true });
    assert.equal(updated.musicalGrid?.bpm, 121); assert.equal(updated.musicalGrid?.beatsPerBar, 3);
    assert.equal(updated.assets, session.assets); assert.equal(session.musicalGrid?.bpm, 120);
  } finally { globalThis.fetch = previous; }
});

test('auto mix snapshots, curated selection, preview defaults and strict validation', async () => {
  const previous = globalThis.fetch;
  const plan = { changes: [{ id: 'automix-a', kind: 'fader', target: 'lead', deltaDb: 2 }, { id: 'automix-b', kind: 'fader', target: 'harmony', deltaDb: 3 }], sections: [], handoffs: [], notes: [], output: { integrated: null, truePeak: null } };
  globalThis.fetch = async () => reply(plan);
  try {
    const session = fixture(); session.tracks.push({ ...createTrack('harmony'), id: 'harmony', clips: [{ ...session.tracks[0].clips[0], id: 'clip2' }] }, { ...createTrack('backing'), id: 'backing', clips: [{ ...session.tracks[0].clips[0], id: 'clip3' }] });
    const jobs = new DawAgentJobs();
    assert.throws(() => jobs.start(session, 1, { kind: 'auto_mix', options: { spaceAmount: null } }), /范围/);
    assert.throws(() => jobs.start(session, 1, { kind: 'auto_mix', options: { roles: { wrong: 'lead' } } }), /未知字段/);
    const job = jobs.start(session, 1, { kind: 'auto_mix', options: { roles: { lead: 'lead', harmony: 'harmony', backing: 'backing' }, excludedChangeIds: ['automix-b'] } });
    const done = await finished(jobs, job.jobId); assert.equal(done.state, 'complete');
    (done.result as any).plan.changes[0].deltaDb = 999;
    const applied = jobs.apply(session, 1, { jobId: job.jobId }); assert.equal(applied.tracks[0].volumeDb, 2); assert.equal(applied.tracks[1].volumeDb, 0);
    assert.throws(() => jobs.apply(session, 1, { jobId: job.jobId, changeIds: ['automix-b'] }), /排除/);
    assert.throws(() => jobs.apply(session, 1, { jobId: job.jobId, changeIds: [] }), /没有选择/);
    const p = jobs.previewSource(session, 1, { jobId: job.jobId, variant: 'balance', start: 0, end: 10 });
    assert.equal(p.preview, false); assert.equal(p.session.tracks[0].volumeDb, 2);
    assert.equal(jobs.previewSource(session, 1, { start: 0, end: 10 }).preview, true);
    assert.throws(() => jobs.previewSource(session, 1, { start: 0, end: 21 }), /试听/);
  } finally { globalThis.fetch = previous; }
});

test('auto mix accepts explicit lead and backing roles without selecting a harmony track', async () => {
  const previous = globalThis.fetch;
  const requests: AutoMixOptions[] = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)).options);
    return reply({
      changes: [{ id: 'automix-a', kind: 'fader', target: 'lead', deltaDb: -2 }],
      sections: [], handoffs: [], notes: [], output: { integrated: null, truePeak: null },
    });
  };
  try {
    const session = fixture();
    for (const name of ['harmony', 'instrumental']) {
      session.tracks.push({ ...createTrack(name), id: name, clips: [{ ...session.tracks[0].clips[0], id: name + '-clip' }] });
    }
    const jobs = new DawAgentJobs();
    const roles = { lead: 'lead', backing: 'instrumental' };
    for (const harmony of [undefined, '', null]) {
      const { jobId } = jobs.start(session, 1, { kind: 'auto_mix', options: {
        roles: harmony === undefined ? roles : { ...roles, harmony },
        harmony: 'mixed', handoffs: [{ start: 5, end: 6 }],
      } });
      assert.equal((await finished(jobs, jobId)).state, 'complete');
      assert.deepEqual(requests.at(-1)?.roles, roles);
      assert.equal(requests.at(-1)?.handoffs, undefined);
      assert.equal(jobs.apply(session, 1, { jobId }).tracks[0].volumeDb, -2);
    }
    assert.throws(() => jobs.start(session, 1, { kind: 'auto_mix', options: { roles: { ...roles, harmony: 'lead' } } }), /各不相同/);
    assert.throws(() => jobs.start(session, 1, { kind: 'auto_mix', options: { roles: { ...roles, backing: '' } } }), /伴奏无效/);
    const detected = jobs.start(session, 1, { kind: 'auto_mix' });
    assert.equal((await finished(jobs, detected.jobId)).state, 'complete');
    assert.equal(requests.at(-1)?.roles.harmony, 'harmony');
  } finally { globalThis.fetch = previous; }
});

test('cancel aborts running jobs, dispose is reusable, and render passes includeTail', async () => {
  const previous = globalThis.fetch; const bodies: any[] = []; let signals: AbortSignal[] = [];
  globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); signals.push(init!.signal as AbortSignal); return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('abort')))); };
  try {
    const session = fixture(), jobs = new DawAgentJobs();
    const first = jobs.start(session, 1, { kind: 'render', includeTail: false }); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(bodies[0].includeTail, false); assert.deepEqual(bodies[0].session.assets[0].peaks, []);
    assert.equal(jobs.cancel(first.jobId).state, 'cancelled'); assert.equal(signals[0].aborted, true);
    const next = jobs.start(session, 1, { kind: 'render' }); await new Promise(resolve => setTimeout(resolve, 0)); jobs.dispose(); assert.equal(signals[1].aborted, true);
    const again = jobs.start(session, 2, { kind: 'render' }); assert.equal(again.state, 'running'); jobs.dispose();
    assert.throws(() => jobs.get(next.jobId), /找不到/);
  } finally { globalThis.fetch = previous; }
});


test('match EQ applies only trusted analysis and validates effect and strengths', async () => {
  const previous = globalThis.fetch; const requests: any[] = [];
  globalThis.fetch = async (_url, init) => { requests.push(JSON.parse(String(init?.body))); return reply({ gains: [1, 2, 3, -1, -2, -3] }); };
  try {
    const session = fixture(), jobs = new DawAgentJobs();
    const job = jobs.start(session, 3, { kind: 'match_eq', target: 'lead', effectId: 'eq', reference: { kind: 'asset', id: 'reference' } });
    assert.equal((await finished(jobs, job.jobId)).state, 'complete');
    assert.equal(requests[0].sourceTarget, 'lead'); assert.equal(requests[0].referenceAssetId, 'reference');
    const applied = jobs.apply(session, 3, { jobId: job.jobId, strength: 75 });
    assert.equal(applied.tracks[0].effects![0].params.matchGain1, 1); assert.equal(applied.tracks[0].effects![0].params.matchStrength, 75);
    assert.throws(() => jobs.apply(session, 3, { jobId: job.jobId, strength: 101 }), /范围/);
    assert.throws(() => jobs.apply(session, 4, { jobId: job.jobId }), /工程已更改/);
  } finally { globalThis.fetch = previous; }
});
