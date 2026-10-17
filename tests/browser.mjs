import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';

const cache = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const profile = await mkdtemp(join(tmpdir(), 'gphotos-swipe-test-'));
await mkdir('artifacts', { recursive: true });
const context = await chromium.launchPersistentContext(profile, {
  ...(existsSync(cache) ? { executablePath: cache } : { channel: 'chromium' }),
  headless: true,
  args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`],
  viewport: { width: 1440, height: 1100 },
});
const errors = [];
// Google's private previews require the account's same-site cookie. Fetch them
// from the signed-in Photos tab rather than anonymously from the review tab.
await context.addCookies([{ name: 'swipe_image_session', value: 'fixture', domain: '.google.com', path: '/', secure: true, httpOnly: true, sameSite: 'Strict' }]);
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
const items = [
  { id: 'one', bytes: 5e6, quota: 3e6 },
  { id: 'two', bytes: 8e6, quota: 6e6 },
  { id: 'free', bytes: 9e6, quota: 0 },
  { id: 'unknown', bytes: 2e6, quota: null },
  { id: 'video', bytes: 3e6, quota: 2e6, duration: 12 },
  { id: 'archived', bytes: 4e6, quota: 2e6, archived: true },
  ...Array.from({ length: 12 }, (_, index) => ({ id: `next-${index + 1}`, bytes: 4e6, quota: 2e6 })),
];
const trashed = new Set();
let mutations = 0, failNext = false, metadataRequests = 0, libraryRequests = 0;
const previewRequests = [];
let holdMutation = null;
async function until(check) {
  const deadline = performance.now() + 10000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error('Timed out waiting for fixture condition');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const timestamp = 1741000000000;
function rawItem(item) {
  const row = Array(16).fill(null);
  row[0] = item.id; row[1] = [`https://photos.fife.usercontent.google.com/${item.id}`, 1500, 1000];
  row[2] = timestamp - items.indexOf(item) * 100000; row[3] = `key-${item.id}`; row[4] = 0; row[5] = timestamp;
  row[7] = []; row[13] = item.archived || false;
  row[15] = item.duration != null ? { '76647426': [item.duration] } : {};
  return row;
}
function rawInfo(item) {
  const row = Array(11).fill(null);
  row[3] = `${item.id}.jpg`; row[6] = timestamp - items.indexOf(item) * 100000; row[9] = item.bytes;
  row[10] = item.quota === null ? [] : [item.quota > 0 ? 1 : 0, item.quota, 2];
  return [item.id, row];
}

await context.route('https://photos.google.com/**', async route => {
  const req = route.request();
  if (!req.url().includes('batchexecute')) {
    await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Google Photos · Test fixture</title><h1>Local integration fixture</h1><script>window.WIZ_global_data={oPEP7c:"reviewer@example.com",SNlM0e:"test-token",eptZe:"/_/PhotosUi/",FdrFJe:"sid",cfb2h:"build"}</script>' });
    return;
  }
  const wrapped = JSON.parse(new URLSearchParams(req.postData()).get('f.req'));
  const rpc = wrapped[0][0][0], args = JSON.parse(wrapped[0][0][1]);
  let data;
  if (rpc === 'lcxiM' || rpc === 'EzkLib') {
    libraryRequests++;
    const visible = items.filter(item => !trashed.has(item.id));
    // Return pages in an order that requires explicit client sorting.
    const pageId = rpc === 'EzkLib' ? args[2] : args[0];
    const chunk = pageId === 'page2' ? visible.slice(2) : visible.slice(0, 2);
    data = [[...chunk].reverse().map(rawItem), pageId === 'page2' ? null : 'page2', String(timestamp)];
  } else if (rpc === 'EWgK9e') {
    metadataRequests++;
    const keys = args[0][0][0].map(row => row[0]);
    assert.ok(keys.every(key => typeof key === 'string'), 'metadata RPC key nesting must match GPTK');
    data = [[null, items.filter(item => keys.includes(item.id)).map(rawInfo)]];
  } else if (rpc === 'zy0IHe') {
    data = [items.filter(item => trashed.has(item.id)).map(rawItem), null];
  } else if (rpc === 'XwAOJf') {
    mutations++;
    const id = args[2][0].replace('key-', '');
    if (holdMutation) await holdMutation;
    if (args[1] === 1) trashed.add(id); else trashed.delete(id);
    if (failNext) { failNext = false; await route.abort('failed'); return; }
    data = [1];
  } else throw new Error(`Unexpected RPC ${rpc}`);
  await route.fulfill({ contentType: 'application/json', body: `)]}'\n\n${JSON.stringify([['wrb.fr', rpc, JSON.stringify(data)]])}\n` });
});
await context.route('https://photos.fife.usercontent.google.com/**', async route => {
  const headers = await route.request().allHeaders();
  previewRequests.push({ id: new URL(route.request().url()).pathname.split('=')[0].slice(1), cookie: headers.cookie || '', mode: headers['sec-fetch-mode'], site: headers['sec-fetch-site'] });
  if (!headers.cookie?.includes('swipe_image_session=fixture')) {
    await route.fulfill({ status: 403, body: 'Photo account session required' });
    return;
  }
  await route.fulfill({ contentType: 'image/svg+xml', headers: { 'Access-Control-Allow-Origin': 'https://photos.google.com', 'Access-Control-Allow-Credentials': 'true' }, body:
    '<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="1000"><defs><linearGradient id="s" x2="0" y2="1"><stop stop-color="#d7e0cf"/><stop offset="1" stop-color="#a6b9a4"/></linearGradient></defs><path fill="url(#s)" d="M0 0h1500v1000H0z"/><circle fill="#e9e1ba" cx="1100" cy="210" r="100"/><path fill="#536a58" d="M0 850L420 220l450 650 280-410 350 450v90H0z"/><path fill="#314b3c" d="M0 900l470-380 490 480H0z"/><text x="30" y="60" fill="white" font-size="36">' + previewRequests.at(-1).id + '</text></svg>' });
});

try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  let source = await context.newPage();
  await source.goto('https://photos.google.com/');
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/review.html`);
  await page.locator('#connect').click();
  await page.locator('#dialog-connect').click();
  await page.locator('#keep').waitFor({ state: 'visible' });
  try {
    await page.waitForFunction(() => !document.getElementById('keep').disabled, null, { timeout: 10000 });
  } catch {
    throw new Error(`Preview did not load: ${JSON.stringify({ requests: previewRequests, errors, ui: await page.locator('#image-loading').textContent(), notice: await page.locator('#notice').textContent() })}`);
  }
  assert.equal(await page.locator('#filename').textContent(), 'one.jpg');
  assert.equal(await page.locator('#file-size').textContent(), '5.0 MB');
  assert.equal(await page.locator('#quota-size').textContent(), '3.0 MB of your account storage');
  assert.equal(await page.locator('#reviewed').textContent(), '0');
  assert.equal(await page.locator('#trash kbd').textContent(), '←');
  assert.equal(await page.locator('#keep kbd').textContent(), '→');
  await page.evaluate(() => {
    window.swipeDirections = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function(frames, options) {
      if (this.matches('.swipe-out')) window.swipeDirections.push({ direction: this.dataset.direction, end: frames.at(-1).transform });
      return animate.call(this, frames, options);
    };
  });
  await until(() => libraryRequests === 2);
  assert.equal(mutations, 0);
  await page.locator('h1').click();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.getElementById('filename').textContent === 'two.jpg' && !document.getElementById('keep').disabled);
  assert.equal(await page.locator('#reviewed').textContent(), '1', 'Keep must work after the sorted index is ready');
  const secondPreview = await page.locator('#photo').evaluate(async image => {
    const text = await (await fetch(image.src)).text();
    return text.includes('>two</text>');
  });
  assert.equal(secondPreview, true, 'the visible preview must match the current photo');
  assert.equal(await page.locator('.swipe-out').count(), 0, 'an earlier photo must not cover the next photo while review controls are enabled');
  for (const swipe of await page.evaluate(() => window.swipeDirections.filter(swipe => swipe.direction === 'right'))) assert.match(swipe.end, /translateX\(110%\)/);
  await page.locator('#undo').click();
  await page.waitForFunction(() => document.getElementById('filename').textContent === 'one.jpg' && !document.getElementById('keep').disabled);
  await page.screenshot({ path: 'artifacts/review-desktop.png', fullPage: true });
  await until(() => new Set(previewRequests.map(request => request.id)).size >= 11);
  assert.deepEqual([...new Set(previewRequests.map(request => request.id))].sort(), ['one', 'two', ...Array.from({ length: 10 }, (_, i) => `next-${i + 1}`)].sort());

  await page.locator('h1').click();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.getElementById('filename').textContent === 'two.jpg');
  assert.equal(await page.locator('#reviewed').textContent(), '1');
  assert.equal(mutations, 0);
  // Browser repeat events may never turn one held key into multiple decisions.
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', repeat: true, bubbles: true })));
  assert.equal(mutations, 0);
  await page.waitForFunction(() => !document.getElementById('trash').disabled);
  let releaseMutation;
  holdMutation = new Promise(resolve => { releaseMutation = resolve; });
  const start = performance.now();
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(() => document.getElementById('filename').textContent === 'next-1.jpg' && !document.getElementById('keep').disabled);
  const advanceMs = Math.round(performance.now() - start);
  assert.equal(await page.locator('.swipe-out').count(), 0, 'a ready next photo must not be covered by an outgoing photo');
  assert.equal(await page.locator('#trashed').textContent(), '0', 'held-open trash must not count before confirmation');
  assert.equal(await page.locator('#queue-status').isVisible(), true);
  await page.locator('#skip').click();
  await page.waitForFunction(() => document.getElementById('filename').textContent === 'next-2.jpg' && !document.getElementById('keep').disabled);
  assert.equal(await page.locator('#trashed').textContent(), '0');
  releaseMutation(); holdMutation = null;
  await page.waitForFunction(() => document.getElementById('trashed').textContent === '1');
  console.log(`Non-blocking trash: next preloaded photo reviewable in ${advanceMs} ms while Google response remained held open.`);
  assert.equal(await page.locator('#storage').textContent(), '0.006');
  assert.ok(trashed.has('two'));
  assert.equal(mutations, 1);
  await page.locator('#undo').click();
  await page.waitForFunction(() => document.getElementById('filename').textContent === 'two.jpg');
  assert.equal(await page.locator('#trashed').textContent(), '0');
  assert.equal(await page.locator('#reviewed').textContent(), '1');
  assert.equal(mutations, 2);
  assert.ok(!trashed.has('two'));

  // Simulate a transport failure after the mutation has already applied.
  failNext = true;
  await page.waitForFunction(() => !document.getElementById('trash').disabled);
  await page.locator('#trash').click();
  await page.locator('#pending').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#trashed').textContent(), '0');
  await page.waitForFunction(() => !document.getElementById('keep').disabled);
  assert.equal(await page.locator('#keep').isDisabled(), false, 'an uncertain deletion must not block reviewing other photos');
  const callsBefore = mutations;
  await page.locator('#reconcile').click();
  await page.waitForFunction(() => document.getElementById('trashed').textContent === '1');
  assert.equal(mutations, callsBefore, 'reconciliation must not repeat the trash request');

  await page.locator('#filter').uncheck();
  await page.waitForFunction(() => document.getElementById('filename').textContent === 'free.jpg');
  assert.equal(await page.locator('#quota-status').textContent(), 'Doesn’t count toward storage');
  await page.screenshot({ path: 'artifacts/review-free-quota.png', fullPage: true });
  await page.reload();
  await page.waitForFunction(() => document.getElementById('reviewed').textContent === '2');
  assert.equal(await page.locator('#filename').textContent(), 'free.jpg');
  assert.equal(await page.locator('#filter').isChecked(), false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'artifacts/review-mobile.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await page.setViewportSize({ width: 1440, height: 1100 });

  // Chrome can suspend a service worker even while the review tab stays open.
  // Local decisions and session Undo must survive that lifecycle boundary.
  const cdp = await context.newCDPSession(page);
  const beforeResumeLibraryRequests = libraryRequests;
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  const resumed = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'status' }));
  assert.equal(resumed.ok, true);
  assert.equal(resumed.state.stats.reviewed, 2);
  assert.equal(resumed.state.stats.trashed, 1);
  assert.equal(resumed.state.current.mediaKey, 'free');
  assert.equal(resumed.state.canUndo, true);
  assert.equal(libraryRequests, beforeResumeLibraryRequests, 'worker suspension must not rescan the whole library before the next action');
  // A Photos tab can be closed and reopened while Chrome preserves the old
  // connection's tab ID. Worker recovery must find the same account again.
  const beforeReopenMutations = mutations;
  await source.close();
  source = await context.newPage();
  await source.goto('https://photos.google.com/');
  await cdp.send('ServiceWorker.stopAllWorkers');
  const reopened = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'status' }));
  assert.equal(reopened.ok, true, 'reopening Photos must not strand review on the missing old tab: ' + reopened.error);
  assert.equal(reopened.state.account, 'reviewer@example.com');
  assert.equal(reopened.state.stats.reviewed, 2);
  assert.equal(reopened.state.stats.trashed, 1);
  assert.equal(mutations, beforeReopenMutations, 'reattaching must not issue Google writes');
  // Recovery also applies while the worker stays alive, and must not attach
  // a different account just because its tab is the only one left open.
  await source.close();
  const differentAccount = await context.newPage();
  await differentAccount.goto('https://photos.google.com/');
  await differentAccount.evaluate(() => { window.WIZ_global_data.oPEP7c = 'unrelated@example.com'; });
  const wrongAccount = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'status' }));
  assert.equal(wrongAccount.ok, false);
  assert.match(wrongAccount.error, /previous Google Photos tab/);
  assert.equal(mutations, beforeReopenMutations);
  const sourcesWhileDisconnected = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'sources' }));
  assert.equal(sourcesWhileDisconnected.ok, true, 'Connect must remain usable with a stale saved tab');
  source = await context.newPage();
  await source.goto('https://photos.google.com/');
  const liveRecovery = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'status' }));
  assert.equal(liveRecovery.ok, true);
  assert.equal(liveRecovery.state.account, 'reviewer@example.com');
  assert.equal(liveRecovery.state.stats.reviewed, 2);
  assert.equal(mutations, beforeReopenMutations);
  await differentAccount.close();
  await cdp.detach();

  // Account changes pause before another decision can be written.
  await source.evaluate(() => { window.WIZ_global_data.oPEP7c = 'other@example.com'; });
  await page.waitForFunction(() => !document.getElementById('keep').disabled);
  await page.locator('#keep').click();
  await page.waitForFunction(() => document.getElementById('notice').textContent.includes('account changed'));
  assert.equal(await page.locator('#keep').isDisabled(), true);
  assert.equal(await page.locator('.swipe-out').count(), 0, 'failed decisions must not animate');
  assert.equal(await page.locator('#reviewed').textContent(), '2');
  await page.locator('#connect').click();
  await page.locator('#dialog-connect').click();
  await page.waitForFunction(() => document.getElementById('account').textContent === 'other@example.com');
  assert.equal(await page.locator('#reviewed').textContent(), '0');
  assert.equal(await page.locator('#filename').textContent(), 'one.jpg');
  // Reset is scoped to the active account and cannot change the remote library.
  await page.waitForFunction(() => !document.getElementById('keep').disabled);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('#keep').click();
  await page.waitForFunction(() => document.getElementById('reviewed').textContent === '1');
  assert.equal(await page.locator('.swipe-out').count(), 0, 'reduced motion skips swipe animations');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const beforeReset = mutations;
  await page.locator('#reset').click();
  await page.keyboard.press('ArrowLeft');
  assert.equal(mutations, beforeReset, 'review shortcuts must not run inside a confirmation dialog');
  await page.locator('#confirm-reset').click();
  await page.waitForFunction(() => document.getElementById('reviewed').textContent === '0');
  assert.equal(mutations, beforeReset);

  // Queue two left-arrow decisions while Google holds the first response,
  // then kill the real worker. The interrupted operation must be verified,
  // while the definitely-unsent second operation can resume exactly once.
  let releaseRestart;
  holdMutation = new Promise(resolve => { releaseRestart = resolve; });
  const beforeRestart = mutations;
  await page.waitForFunction(() => !document.getElementById('trash').disabled);
  await page.locator('#trash').click();
  await page.waitForFunction(() => document.getElementById('filename').textContent === 'next-1.jpg' && !document.getElementById('trash').disabled);
  await page.locator('#trash').click();
  await page.waitForFunction(() => document.getElementById('filename').textContent === 'next-2.jpg' && !document.getElementById('keep').disabled);
  await until(() => mutations === beforeRestart + 1);
  assert.equal(await page.locator('#trashed').textContent(), '0');
  assert.ok((await page.locator('#queue-status').textContent()).startsWith('2 '));
  const restartCdp = await context.newCDPSession(page);
  await restartCdp.send('ServiceWorker.enable');
  await restartCdp.send('ServiceWorker.stopAllWorkers');
  releaseRestart(); holdMutation = null;
  await until(() => trashed.has('one'));
  await page.reload();
  await page.locator('#pending').waitFor({ state: 'visible' });
  assert.equal(mutations, beforeRestart + 1, 'restart must not resend an interrupted mutation');
  await page.locator('#reconcile').click();
  await page.waitForFunction(() => document.getElementById('trashed').textContent === '2' && document.getElementById('queue-status').hidden);
  assert.equal(mutations, beforeRestart + 2, 'only the definitely-unsent queue entry may be sent after verification');
  await restartCdp.detach();

  // If the index cache is unavailable after trash completed, a fresh scan will
  // exclude that photo. Undo must still display its verified restored preview.
  await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase('photos-swipe-cache');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  }));
  const coldCdp = await context.newCDPSession(page);
  await coldCdp.send('ServiceWorker.enable');
  await coldCdp.send('ServiceWorker.stopAllWorkers');
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('undo').disabled);
  await page.locator('#undo').click();
  await page.waitForFunction(() => document.getElementById('filename').textContent === 'next-1.jpg' && !document.getElementById('keep').disabled);
  assert.equal(await page.locator('#trashed').textContent(), '1');
  assert.ok(!trashed.has('next-1'));
  await coldCdp.detach();
  assert.deepEqual(errors, []);
  assert.ok(metadataRequests > 0);
  console.log('Browser integration passed: real MV3 worker, MAIN-world RPC, pagination, metadata, keyboard, trash/restore, uncertain outcome, quota filtering, persistence, worker suspension, reopened-tab recovery, account isolation, reset, responsive layout, ten-photo preloading, and held-open non-blocking deletion.');
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
