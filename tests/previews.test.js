import test from 'node:test';
import assert from 'node:assert/strict';
import { PreviewCache } from '../src/previews.js';

test('ten upcoming images preload and decode with bounded concurrency and deduplicated requests', async () => {
  let active = 0, maximum = 0, loaded = 0, decoded = 0;
  const cache = new PreviewCache(async key => {
    loaded++; active++; maximum = Math.max(maximum, active);
    await new Promise(setImmediate);
    active--;
    return key;
  }, async data => { decoded++; return { data }; });
  const keys = Array.from({ length: 11 }, (_, index) => `image-${index}`);
  await Promise.all(keys.map(key => cache.get(key)));
  await cache.get('image-1');
  assert.equal(loaded, 11);
  assert.equal(decoded, 11);
  assert.equal(maximum, 3);
  cache.retain(keys.slice(1));
  assert.equal(cache.entries.size, 10);
  assert.ok(cache.entries.get('image-1').image);
});

test('failed preview requests are retryable rather than permanently cached', async () => {
  let attempt = 0;
  const cache = new PreviewCache(async () => { if (++attempt === 1) throw new Error('Network failed'); return 'image'; }, async data => data);
  await assert.rejects(cache.get('one'), /Network failed/);
  assert.equal(await cache.get('one'), 'image');
  assert.equal(attempt, 2);
});

test('current image takes priority over queued preloads and discarded entries do not load', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const order = [];
  const cache = new PreviewCache(async key => { order.push(key); if (key === 'first') await gate; return key; }, async data => data, 1);
  const first = cache.get('first');
  const discarded = cache.get('discard');
  const preloaded = cache.get('later');
  const current = cache.get('current', true);
  cache.retain(['first', 'later', 'current']);
  release();
  await Promise.all([first, current, preloaded]);
  await assert.rejects(discarded, /discarded/);
  assert.deepEqual(order, ['first', 'current', 'later']);
});
