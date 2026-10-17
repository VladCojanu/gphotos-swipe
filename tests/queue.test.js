import test from 'node:test';
import assert from 'node:assert/strict';
import { blankState } from '../src/model.js';
import { fixture } from './helpers.js';

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function drained(engine) { while (engine.queueTask) await engine.queueTask; }

test('multiple decisions remain responsive and concurrent completions preserve every durable decision', async () => {
  const rig = fixture();
  const gate = deferred(), started = deferred();
  let active = 0, maxActive = 0;
  rig.google.mutate = async (action, item) => {
    active++; maxActive = Math.max(maxActive, active);
    rig.calls.push(item.mediaKey);
    if (item.mediaKey === 'photo-0') { started.resolve(); await gate.promise; }
    rig.locations.set(item.mediaKey, 'trash');
    active--;
  };
  await rig.engine.connect();
  await rig.engine.decide('trash', 'photo-0');
  await started.promise;
  await rig.engine.decide('trash', 'photo-1');
  await rig.engine.decide('keep', 'photo-2');
  assert.equal(rig.engine.current.mediaKey, 'photo-3');
  assert.equal(rig.engine.snapshot().pendingCount, 2);
  assert.deepEqual(rig.engine.snapshot().stats, { reviewed: 1, trashed: 0, bytes: 0, unknown: 0 });
  assert.equal(rig.records.get(rig.engine.account).outbox.length, 2);
  gate.resolve();
  await drained(rig.engine);
  assert.deepEqual(rig.engine.snapshot().stats, { reviewed: 3, trashed: 2, bytes: 4000000, unknown: 0 });
  assert.equal(rig.engine.snapshot().pendingCount, 0);
  assert.equal(maxActive, 1);
  assert.deepEqual(rig.calls, ['photo-0', 'photo-1']);
});

test('Undo cancels a queued deletion before it reaches Google', async () => {
  const rig = fixture();
  const gate = deferred(), started = deferred();
  rig.google.mutate = async (action, item) => {
    rig.calls.push(item.mediaKey);
    started.resolve(); await gate.promise;
    rig.locations.set(item.mediaKey, 'trash');
  };
  await rig.engine.connect();
  await rig.engine.decide('trash', 'photo-0');
  await started.promise;
  await rig.engine.decide('trash', 'photo-1');
  await rig.engine.undo();
  assert.equal(rig.engine.current.mediaKey, 'photo-1');
  assert.equal(rig.engine.snapshot().pendingCount, 1);
  gate.resolve();
  await drained(rig.engine);
  assert.deepEqual(rig.calls, ['photo-0']);
  assert.equal(rig.engine.snapshot().stats.trashed, 1);
});

test('Undo during an in-flight deletion restores only after Google confirms trash', async () => {
  const rig = fixture();
  const gate = deferred(), started = deferred();
  rig.google.mutate = async (action, item) => {
    rig.calls.push(action);
    if (action === 'trash') { started.resolve(); await gate.promise; }
    rig.locations.set(item.mediaKey, action === 'trash' ? 'trash' : 'library');
  };
  await rig.engine.connect();
  await rig.engine.decide('trash', 'photo-0');
  await started.promise;
  await rig.engine.undo();
  assert.deepEqual(rig.calls, ['trash']);
  assert.equal(rig.engine.snapshot().stats.trashed, 0);
  gate.resolve();
  await drained(rig.engine);
  assert.deepEqual(rig.calls, ['trash', 'restore']);
  assert.equal(rig.engine.snapshot().pendingCount, 0);
  assert.equal(rig.engine.snapshot().stats.reviewed, 0);
  assert.equal(rig.engine.current.mediaKey, 'photo-0');
});

test('background Undo does not replace the photo after the user has continued reviewing', async () => {
  const rig = fixture();
  const gate = deferred(), started = deferred();
  rig.google.mutate = async (action, item) => {
    if (action === 'trash') { started.resolve(); await gate.promise; }
    rig.locations.set(item.mediaKey, action === 'trash' ? 'trash' : 'library');
  };
  await rig.engine.connect();
  await rig.engine.decide('trash', 'photo-0');
  await started.promise;
  await rig.engine.undo();
  await rig.engine.decide('keep', 'photo-1');
  gate.resolve();
  await drained(rig.engine);
  assert.equal(rig.engine.current.mediaKey, 'photo-2');
  assert.equal(rig.engine.snapshot().stats.reviewed, 1);
  assert.equal(rig.engine.snapshot().stats.trashed, 0);
});

test('uncertain results pause the sender but allow keep and queueing; reconciliation never repeats a mutation', async () => {
  const rig = fixture();
  let fail = true;
  rig.google.mutate = async (action, item) => {
    rig.calls.push(item.mediaKey);
    rig.locations.set(item.mediaKey, 'trash');
    if (fail) { fail = false; throw new Error('Connection lost after sending'); }
  };
  await rig.engine.connect();
  await rig.engine.decide('trash', 'photo-0');
  await drained(rig.engine);
  await rig.engine.decide('trash', 'photo-1');
  await rig.engine.decide('keep', 'photo-2');
  assert.deepEqual(rig.calls, ['photo-0']);
  assert.equal(rig.engine.snapshot().pendingCount, 2);
  assert.equal(rig.engine.snapshot().stats.reviewed, 1);
  assert.ok(rig.engine.snapshot().pending);
  await rig.engine.reconcile();
  await drained(rig.engine);
  assert.deepEqual(rig.calls, ['photo-0', 'photo-1']);
  assert.equal(rig.engine.snapshot().stats.reviewed, 3);
  assert.equal(rig.engine.snapshot().stats.trashed, 2);
});

test('restart verifies interrupted sending and resumes only definitely-unsent queued operations', async () => {
  const rig = fixture();
  const state = { ...blankState(), outbox: [
    { id: 'interrupted', kind: 'trash', item: rig.items[0], status: 'sending' },
    { id: 'not-sent', kind: 'trash', item: rig.items[1], status: 'queued' },
  ] };
  rig.records.set('test@example.com', state);
  rig.locations.set('photo-0', 'trash');
  await rig.engine.connect();
  assert.ok(rig.engine.snapshot().pending);
  assert.equal(rig.calls.length, 0);
  assert.equal(rig.engine.current.mediaKey, 'photo-2');
  await rig.engine.reconcile();
  await drained(rig.engine);
  assert.deepEqual(rig.calls.map(call => call.key), ['photo-1']);
  assert.equal(rig.engine.snapshot().stats.trashed, 2);
});

test('a legacy pending operation migrates to uncertainty without issuing a mutation', async () => {
  const rig = fixture();
  rig.records.set('test@example.com', { version: 1, decisions: {}, onlyStorage: true,
    pending: { kind: 'trash', item: rig.items[0], startedAt: 1 } });
  await rig.engine.connect();
  assert.equal(rig.calls.length, 0);
  assert.equal(rig.engine.state.version, 2);
  assert.equal(rig.engine.snapshot().pendingCount, 1);
  assert.ok(rig.engine.snapshot().pending);
  assert.equal(rig.engine.current.mediaKey, 'photo-1');
});

test('failed durable completion can be reconciled without counting twice or resending', async () => {
  const rig = fixture();
  const save = rig.store.save;
  let fail = true;
  rig.store.save = async (account, state) => {
    if (fail && state.decisions['photo-0']) throw new Error('Disk write failed');
    await save(account, state);
  };
  await rig.engine.connect();
  await rig.engine.decide('trash', 'photo-0');
  await drained(rig.engine);
  assert.equal(rig.engine.snapshot().stats.trashed, 0);
  assert.ok(rig.engine.snapshot().pending);
  fail = false;
  await rig.engine.reconcile();
  assert.equal(rig.engine.snapshot().stats.trashed, 1);
  assert.equal(rig.calls.length, 1);
});

test('an account change prevents a queued operation from being sent', async () => {
  const rig = fixture();
  await rig.engine.connect();
  // Pause the sender with an uncertain operation, then enqueue another.
  rig.google.mutate = async () => { throw new Error('Disconnected'); };
  await rig.engine.decide('trash', 'photo-0');
  await drained(rig.engine);
  await rig.engine.decide('trash', 'photo-1');
  rig.google.health = async () => ({ account: 'different@example.com' });
  await assert.rejects(rig.engine.reconcile(), /account changed/);
  assert.equal(rig.engine.connected, false);
  assert.equal(rig.engine.snapshot().pendingCount, 2);
});

test('Undo of an uncertain deletion already in the library returns it without issuing restore', async () => {
  const rig = fixture();
  let calls = 0;
  rig.google.mutate = async () => { calls++; throw new Error('Request failed before applying'); };
  await rig.engine.connect();
  await rig.engine.decide('trash', 'photo-0');
  await drained(rig.engine);
  await rig.engine.undo();
  await rig.engine.reconcile();
  assert.equal(calls, 1);
  assert.equal(rig.engine.current.mediaKey, 'photo-0');
  assert.equal(rig.engine.snapshot().stats.reviewed, 0);
  assert.equal(rig.engine.snapshot().pendingCount, 0);
});

test('even a failed uncertainty write leaves sending state visible and prevents automatic resends', async () => {
  const rig = fixture();
  const save = rig.store.save;
  let diskFailed = false;
  rig.store.save = async (account, state) => {
    if (diskFailed) throw new Error('Disk unavailable');
    await save(account, state);
  };
  rig.google.mutate = async (action, item) => {
    rig.calls.push(item.mediaKey);
    rig.locations.set(item.mediaKey, 'trash');
    diskFailed = true;
  };
  await rig.engine.connect();
  await rig.engine.decide('trash', 'photo-0');
  await drained(rig.engine);
  assert.equal(rig.engine.snapshot().stats.trashed, 0);
  assert.ok(rig.engine.snapshot().pending);
  assert.equal(rig.calls.length, 1);
  diskFailed = false;
  await rig.engine.reconcile();
  assert.equal(rig.engine.snapshot().stats.trashed, 1);
  assert.equal(rig.calls.length, 1);
});
