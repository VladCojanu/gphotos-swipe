import test from 'node:test';
import assert from 'node:assert/strict';
import { REVIEW_ORDER } from '../src/model.js';
import { fixture } from './helpers.js';

test('the next ten eligible photos are prepared, including across metadata batches', async () => {
  const rig = fixture(50);
  for (let i = 1; i < 40; i++) { rig.items[i].takesUpSpace = false; rig.items[i].spaceTaken = 0; }
  await rig.engine.connect();
  await rig.engine.warming;
  assert.deepEqual(rig.engine.snapshot().upcoming.map(item => item.mediaKey), Array.from({ length: 10 }, (_, i) => `photo-${40 + i}`));
});

test('a held-open Google trash request cannot block advancing or keeping the next photo', async () => {
  const rig = fixture(3);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  rig.google.mutate = async () => { await gate; rig.locations.set('photo-0', 'trash'); };
  await rig.engine.connect();
  let settled = false;
  const action = rig.engine.decide('trash', 'photo-0').then(() => { settled = true; });
  try {
    await new Promise(setImmediate);
    assert.equal(settled, true, 'accepting a trash decision must finish before Google responds');
    assert.equal(rig.engine.current.mediaKey, 'photo-1');
    assert.equal(rig.engine.snapshot().stats.trashed, 0, 'unconfirmed deletions must not inflate counters');
    await rig.engine.decide('keep', 'photo-1');
    assert.equal(rig.engine.current.mediaKey, 'photo-2');
  } finally { release(); await action; }
});

test('worker resume uses cached identifiers with fresh decisions instead of a full-library network scan', async () => {
  const rig = fixture();
  rig.records.set('test@example.com', { version: 2, sequence: 4, onlyStorage: true, pending: null, outbox: [],
    decisions: { 'photo-0': { action: 'keep', at: 1, bytes: null } } });
  rig.google.listPage = async () => { throw new Error('A full rescan would stall navigation'); };
  await rig.engine.connect({ order: REVIEW_ORDER, account: 'test@example.com', items: rig.items, metadata: rig.items.map(item => [item.mediaKey, item]) });
  assert.equal(rig.engine.current.mediaKey, 'photo-1');
  assert.equal(rig.engine.snapshot().stats.reviewed, 1);
  assert.equal(rig.engine.snapshot().upcoming.length, 10);
});

test('cached library data from a different account cannot bypass account validation', async () => {
  const rig = fixture();
  let scans = 0;
  rig.google.listPage = async () => { scans++; return { items: rig.items, nextPageId: null }; };
  await rig.engine.connect({ order: REVIEW_ORDER, account: 'someone-else@example.com', items: [{ mediaKey: 'foreign' }], metadata: [] });
  assert.equal(scans, 1);
  assert.equal(rig.engine.current.mediaKey, 'photo-0');
});

test('review waits for all pages before selecting the newest photo', async () => {
  const rig = fixture(20);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  rig.google.listPage = async (_account, cursor) => {
    if (cursor) await gate;
    return cursor ? { items: rig.items.slice(0, 12), nextPageId: null }
      : { items: rig.items.slice(12), nextPageId: 'page-two' };
  };
  let connected = false;
  const connecting = rig.engine.connect().then(() => { connected = true; });
  try {
    await new Promise(setImmediate);
    assert.equal(connected, false);
    assert.equal(rig.engine.current, null);
  } finally { release(); await connecting; }
  assert.equal(rig.engine.current.mediaKey, 'photo-0');
});

test('a partial cached library resumes at its saved cursor and loads through ineligible pages', async () => {
  const rig = fixture(20);
  const cursors = [];
  rig.google.listPage = async (_account, cursor) => {
    cursors.push(cursor);
    return cursor === 'empty-page' ? { items: [], nextPageId: 'last-page' }
      : { items: rig.items.slice(2), nextPageId: null };
  };
  const decisions = Object.fromEntries(rig.items.slice(0, 2).map(item => [item.mediaKey, { action: 'keep' }]));
  rig.records.set('test@example.com', { decisions });
  await rig.engine.connect({ order: REVIEW_ORDER, account: 'test@example.com', items: rig.items.slice(0, 2), metadata: [],
    complete: false, cursor: 'empty-page', pages: ['empty-page'] });
  assert.equal(rig.engine.current.mediaKey, 'photo-2');
  assert.deepEqual(cursors, ['empty-page', 'last-page']);
});

test('sorting finishes pagination even when the first page fills the preview buffer', async () => {
  const rig = fixture(20);
  let requests = 0;
  rig.google.listPage = async (_account, cursor) => {
    requests++;
    return cursor ? { items: rig.items.slice(12), nextPageId: null }
      : { items: rig.items.slice(0, 12), nextPageId: 'unread-page' };
  };
  await rig.engine.connect();
  await rig.engine.warming;
  assert.equal(requests, 2);
  assert.equal(rig.engine.complete, true);
  assert.equal(rig.engine.snapshot().upcoming.length, 10);
});

test('repeated continuation tokens fail safely instead of looping forever', async () => {
  const rig = fixture(0);
  rig.google.listPage = async () => ({ items: [], nextPageId: 'same-page' });
  await assert.rejects(rig.engine.connect(), /repeated a page/);
});
