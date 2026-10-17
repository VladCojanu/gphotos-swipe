import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewEngine, blankState, quotaStatus, quotaBytes, statistics } from '../src/model.js';

const photo = (mediaKey, extra = {}) => ({ mediaKey, dedupKey: `delete-${mediaKey}`, timestamp: 1700000000000,
  fileName: `${mediaKey}.jpg`, size: 6000000, takesUpSpace: true, spaceTaken: 4000000, ...extra });

function setup(items = [photo('a'), photo('b')], saved = null) {
  const calls = [], records = new Map();
  if (saved) records.set('one@example.com', structuredClone(saved));
  let account = 'one@example.com';
  let location = 'library';
  const store = {
    async load(key) { return structuredClone(records.get(key)); },
    async save(key, value) { records.set(key, structuredClone(value)); },
  };
  const google = {
    async health() { return { account }; },
    async listPage() { return { items, nextPageId: null }; },
    async metadata(keys) { return items.filter(item => keys.includes(item.mediaKey)); },
    async mutate(action, item, key) { calls.push({ action, item, key }); location = action === 'trash' ? 'trash' : 'library'; },
    async locate() { return location; },
  };
  return { engine: new ReviewEngine(store, google), google, store, calls, records,
    setAccount(value) { account = value; }, setLocation(value) { location = value; } };
}

test('quota classification distinguishes missing and contradictory values from zero quota', () => {
  assert.equal(quotaStatus({ takesUpSpace: false }), 'free');
  assert.equal(quotaBytes({ takesUpSpace: false }), 0);
  assert.equal(quotaStatus({ takesUpSpace: true, spaceTaken: 12 }), 'used');
  assert.equal(quotaBytes({ takesUpSpace: true, spaceTaken: 12 }), 12);
  assert.equal(quotaStatus({ takesUpSpace: true }), 'used');
  assert.equal(quotaBytes({ takesUpSpace: true }), null);
  for (const item of [{}, { takesUpSpace: null }, { takesUpSpace: false, spaceTaken: 2 }, { takesUpSpace: true, spaceTaken: 0 }]) {
    assert.equal(quotaStatus(item), 'unknown');
    assert.equal(quotaBytes(item), null);
  }
});

test('viewing never counts; keep counts once and Undo reverses it without Google mutation', async () => {
  const { engine, calls } = setup();
  await engine.connect();
  assert.equal(engine.snapshot().stats.reviewed, 0);
  await engine.decide('keep', 'a');
  assert.equal(engine.snapshot().stats.reviewed, 1);
  assert.equal(engine.current.mediaKey, 'b');
  await assert.rejects(engine.decide('keep', 'a'), /photo has changed/);
  await engine.undo();
  assert.equal(engine.snapshot().stats.reviewed, 0);
  assert.equal(engine.current.mediaKey, 'a');
  assert.equal(engine.snapshot().canUndo, false);
  assert.deepEqual(calls, []);
});

test('trash is verified before accounting; Undo restores and subtracts quota rather than file size', async () => {
  const { engine, calls, records } = setup();
  await engine.connect();
  await engine.decide('trash', 'a');
  await engine.queueTask;
  assert.deepEqual(engine.snapshot().stats, { reviewed: 1, trashed: 1, bytes: 4000000, unknown: 0 });
  assert.equal(records.get(engine.account).pending, null);
  await engine.undo();
  await engine.queueTask;
  assert.deepEqual(engine.snapshot().stats, { reviewed: 0, trashed: 0, bytes: 0, unknown: 0 });
  assert.equal(engine.current.mediaKey, 'a');
  assert.deepEqual(calls.map(call => call.action), ['trash', 'restore']);
});

test('timeout after Google applies trash persists uncertainty and reconciles exactly once after restart', async () => {
  const rig = setup();
  const { engine, google, store } = rig;
  await engine.connect();
  google.mutate = async () => { rig.setLocation('trash'); throw new Error('network timeout'); };
  await engine.decide('trash', 'a');
  await engine.queueTask;
  assert.equal(engine.snapshot().stats.reviewed, 0);
  assert.equal(engine.snapshot().pending.kind, 'trash');
  await assert.rejects(engine.decide('keep', 'a'), /photo has changed/);
  const restarted = new ReviewEngine(store, google);
  await restarted.connect();
  assert.equal(restarted.current.mediaKey, 'b');
  await restarted.reconcile();
  await restarted.reconcile();
  assert.equal(restarted.snapshot().stats.trashed, 1);
  assert.equal(restarted.current.mediaKey, 'b');
});

test('failed mutation can be reconciled as not applied without advancing or changing counters', async () => {
  const { engine, google } = setup();
  await engine.connect();
  google.mutate = async () => { throw new Error('HTTP 500'); };
  await engine.decide('trash', 'a');
  await engine.queueTask;
  await engine.reconcile();
  assert.equal(engine.current.mediaKey, 'b');
  await engine.decide('keep', 'b');
  assert.equal(engine.current.mediaKey, 'a');
  assert.equal(engine.snapshot().stats.reviewed, 1);
  assert.equal(engine.snapshot().stats.trashed, 0);
  assert.equal(engine.state.pending, null);
});

test('unknown location remains pending, blocks reset, and allows continued review', async () => {
  const rig = setup();
  await rig.engine.connect();
  rig.google.mutate = async () => rig.setLocation('unknown');
  await rig.engine.decide('trash', 'a');
  await rig.engine.queueTask;
  assert.ok(rig.engine.snapshot().pending);
  await assert.rejects(rig.engine.reset(), /pending/);
  await rig.engine.filter(false);
  assert.equal(rig.engine.current.mediaKey, 'b');
  assert.equal(rig.engine.snapshot().stats.reviewed, 0);
});

test('failed restoration preserves the deletion statistic until confirmed restored', async () => {
  const rig = setup();
  await rig.engine.connect();
  await rig.engine.decide('trash', 'a');
  await rig.engine.queueTask;
  rig.google.mutate = async () => { throw new Error('restore failed'); };
  await rig.engine.undo();
  await rig.engine.queueTask;
  assert.equal(rig.engine.snapshot().stats.trashed, 1);
  await rig.engine.reconcile();
  assert.equal(rig.engine.snapshot().stats.trashed, 1);
  assert.equal(rig.engine.snapshot().canUndo, true);
});

test('storage filter skips free and unknown photos without counting them; other media and archive stay excluded', async () => {
  const rig = setup([photo('free', { takesUpSpace: false, spaceTaken: 0 }), photo('unknown', { takesUpSpace: null, spaceTaken: undefined }),
    photo('video', { duration: 10 }), photo('video2', { fileName: 'clip.MOV' }), photo('archive', { isArchived: true }), photo('used')]);
  await rig.engine.connect();
  assert.equal(rig.engine.current.mediaKey, 'used');
  assert.equal(rig.engine.snapshot().stats.reviewed, 0);
  await rig.engine.filter(false);
  assert.equal(rig.engine.current.mediaKey, 'free');
  await rig.engine.decide('trash', 'free');
  await rig.engine.queueTask;
  assert.deepEqual(rig.engine.snapshot().stats, { reviewed: 1, trashed: 1, bytes: 0, unknown: 0 });
  await rig.engine.decide('trash', 'unknown');
  await rig.engine.queueTask;
  assert.equal(rig.engine.snapshot().stats.unknown, 1);
  assert.equal(rig.engine.current.mediaKey, 'used');
});

test('shared deletion keys across archived entries block trash but allow keep and skip', async () => {
  const rig = setup([photo('a', { dedupKey: 'shared' }), photo('archived', { dedupKey: 'shared', isArchived: true }), photo('b')]);
  await rig.engine.connect();
  assert.equal(rig.engine.snapshot().canTrash, false);
  await assert.rejects(rig.engine.decide('trash', 'a'), /shared deletion key/);
  assert.equal(rig.calls.length, 0);
  await rig.engine.skip();
  assert.equal(rig.engine.current.mediaKey, 'b');
  assert.equal(rig.engine.snapshot().stats.reviewed, 0);
});

test('account change blocks actions before any write or Google mutation', async () => {
  const rig = setup();
  await rig.engine.connect();
  rig.setAccount('two@example.com');
  await assert.rejects(rig.engine.decide('trash', 'a'), /account changed/);
  assert.equal(rig.calls.length, 0);
  assert.equal(rig.records.size, 0);
  await rig.engine.connect();
  assert.equal(rig.engine.account, 'two@example.com');
  assert.equal(rig.engine.snapshot().stats.reviewed, 0);
});

test('history persists across sessions and reopening prefers new unreviewed items', async () => {
  const saved = { ...blankState(), decisions: { a: { action: 'keep', bytes: null, at: 1 } } };
  const rig = setup([photo('new'), photo('a'), photo('old')], saved);
  await rig.engine.connect();
  assert.equal(rig.engine.current.mediaKey, 'new');
  assert.equal(rig.engine.snapshot().stats.reviewed, 1);
  await rig.engine.reset();
  assert.equal(rig.engine.snapshot().stats.reviewed, 0);
  assert.equal(rig.calls.length, 0);
});

test('storage write failure cannot count or mutate a photo without a durable pending record', async () => {
  const rig = setup();
  await rig.engine.connect();
  rig.store.save = async () => { throw new Error('disk full'); };
  await assert.rejects(rig.engine.decide('trash', 'a'), /disk full/);
  assert.equal(rig.calls.length, 0);
  assert.equal(rig.engine.snapshot().stats.reviewed, 0);
  assert.equal(rig.engine.state.pending, null);
});

test('statistics use decision states and disclose unknown quota contributions', () => {
  assert.deepEqual(statistics({ a: { action: 'keep' }, b: { action: 'trash', bytes: null }, c: { action: 'trash', bytes: 0 }, d: { action: 'trash', bytes: 12 } }),
    { reviewed: 4, trashed: 3, bytes: 12, unknown: 1 });
});
