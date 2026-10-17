import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';

test('review follows capture dates across pages even when upload order differs', async () => {
  const rig = fixture(4);
  const chronological = [...rig.items];
  rig.items.splice(0, 4, chronological[2], chronological[0], chronological[3], chronological[1]);
  const cursors = [];
  rig.google.listPage = async (_account, cursor) => {
    cursors.push(cursor);
    return cursor ? { items: chronological.slice(2), nextPageId: null }
      : { items: chronological.slice(0, 2), nextPageId: 'older' };
  };
  await rig.engine.connect();
  const dates = [];
  while (rig.engine.current) {
    dates.push(rig.engine.current.timestamp);
    await rig.engine.decide('keep', rig.engine.current.mediaKey);
  }
  assert.deepEqual(dates, chronological.map(item => item.timestamp), 'dates must descend across the entire review queue');
  assert.deepEqual(cursors, [null, 'older']);
});

test('legacy upload-order caches and their cursors are discarded without losing decisions', async () => {
  const rig = fixture(4);
  rig.records.set('test@example.com', { decisions: { 'photo-0': { action: 'keep' } } });
  const cursors = [];
  rig.google.listPage = async (_account, cursor) => {
    cursors.push(cursor);
    return { items: rig.items, nextPageId: null };
  };
  await rig.engine.connect({ account: 'test@example.com', items: [...rig.items].reverse(),
    metadata: rig.items.map(item => [item.mediaKey, item]), cursor: 'old-upload-cursor', complete: false });
  assert.deepEqual(cursors, [null]);
  assert.equal(rig.engine.current.mediaKey, 'photo-1');
  assert.equal(rig.engine.snapshot().stats.reviewed, 1);
});

test('explicit sorting uses final metadata dates across unordered pages', async () => {
  const rig = fixture(5);
  const finalDates = [100, 500, 300, 500, null];
  rig.google.listPage = async (_account, cursor) => cursor
    ? { items: rig.items.slice(2), nextPageId: null }
    : { items: rig.items.slice(0, 2), nextPageId: 'more' };
  rig.google.metadata = async keys => rig.items.filter(item => keys.includes(item.mediaKey))
    .map((item, i) => ({ ...item, timestamp: finalDates[Number(item.mediaKey.split('-')[1])] }));
  rig.items[4].timestamp = null;
  await rig.engine.connect();
  const expected = ['photo-1', 'photo-3', 'photo-2', 'photo-0', 'photo-4'];
  assert.equal(rig.engine.current.mediaKey, expected[0]);
  assert.deepEqual(rig.engine.snapshot().upcoming.map(item => item.mediaKey), expected.slice(1));
  const actual = [];
  while (rig.engine.current) {
    actual.push(rig.engine.current.mediaKey);
    await rig.engine.decide('keep', rig.engine.current.mediaKey);
  }
  assert.deepEqual(actual, expected);
});

test('reviewed photos never repeat across overlapping pages, cached resume, or reconnect', async () => {
  const rig = fixture(6);
  rig.google.listPage = async (_account, cursor) => cursor
    ? { items: [...rig.items].reverse(), nextPageId: null }
    : { items: rig.items.slice(0, 3), nextPageId: 'overlap' };
  await rig.engine.connect();
  const reviewed = [];
  for (let i = 0; i < 3; i++) {
    reviewed.push(rig.engine.current.mediaKey);
    await rig.engine.decide('keep', rig.engine.current.mediaKey);
  }
  const { REVIEW_ORDER, ReviewEngine } = await import('../src/model.js');
  const cache = { order: REVIEW_ORDER, account: rig.engine.account,
    items: [...rig.engine.items], metadata: [...rig.engine.metadata], complete: true };
  rig.engine.stop();
  rig.engine = new ReviewEngine(rig.store, rig.google);
  await rig.engine.connect(cache);
  assert.equal(reviewed.includes(rig.engine.current.mediaKey), false);
  await rig.engine.connect();
  while (rig.engine.current) {
    assert.equal(reviewed.includes(rig.engine.current.mediaKey), false);
    reviewed.push(rig.engine.current.mediaKey);
    await rig.engine.decide('keep', rig.engine.current.mediaKey);
  }
  assert.equal(reviewed.length, 6);
  assert.equal(new Set(reviewed).size, 6);
});
