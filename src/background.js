import { ReviewEngine, REVIEW_ORDER } from './model.js';
import { GooglePhotos } from './google.js';
import { readLibraryCache, writeLibraryCache } from './library-cache.js';

const reviewUrl = chrome.runtime.getURL('review.html');
const store = {
  async load(account) { return (await chrome.storage.local.get(`account:${account}`))[`account:${account}`]; },
  async save(account, state) { await chrome.storage.local.set({ [`account:${account}`]: state }); },
};
let engine = null;
let busy = false;
let progress = '';

function report(message) {
  progress = message;
  chrome.runtime.sendMessage({ type: 'progress', message }).catch(() => {});
}

async function openReview() {
  const tabs = await chrome.tabs.query({ url: reviewUrl });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    if (engine) engine.last = null;
    await chrome.storage.session.remove('undo');
    await chrome.tabs.create({ url: reviewUrl });
  }
}
chrome.action.onClicked.addListener(() => openReview().catch(console.error));

async function connect(tabId, resume = false) {
  const tabs = await chrome.tabs.query({ url: 'https://photos.google.com/*' });
  const previous = (await chrome.storage.session.get('connection')).connection;
  let selected = tabId ? tabs.find(tab => tab.id === tabId) : tabs.find(tab => tab.active) || tabs[0];
  if (!selected && resume && previous?.account) {
    // Chrome may reopen Photos under a different tab ID. Probe identity only:
    // never resume another account's queue or choose an account by tab order.
    for (const tab of [...tabs].sort((a, b) => Number(b.active) - Number(a.active))) {
      try {
        const health = await new GooglePhotos(tab.id).health();
        if (health.account === previous.account) { selected = tab; break; }
      } catch { /* A loading or signed-out tab is not a recovery candidate. */ }
    }
  }
  if (!selected) throw new Error(tabs.length
    ? 'The previous Google Photos tab is no longer available. Click Connect to select your open Photos tab.'
    : 'Open Google Photos and sign in, then click Connect.');
  if (engine) { engine.stop(); await engine.writes; }
  let cache = null;
  if (resume && previous) {
    try { cache = await readLibraryCache(previous.cacheId); } catch { /* Cache misses fall back to fresh pagination. */ }
  }
  let cacheId = cache?.id || crypto.randomUUID();
  let cacheSignature = '';
  let cacheWrites = Promise.resolve();
  let activeEngine;
  const saveCache = () => {
    if (!activeEngine || activeEngine.stopped) return cacheWrites;
    const signature = `${activeEngine.items.length}:${activeEngine.metadata.size}:${activeEngine.cursor}`;
    if (signature === cacheSignature) return cacheWrites;
    cacheSignature = signature;
    const value = { id: cacheId, order: REVIEW_ORDER, account: activeEngine.account, items: [...activeEngine.items],
      metadata: [...activeEngine.metadata], cursor: activeEngine.cursor, complete: activeEngine.complete,
      pages: [...activeEngine.pages] };
    cacheWrites = cacheWrites.then(() => activeEngine.stopped ? undefined : writeLibraryCache(value)).catch(() => { cacheSignature = ''; });
    return cacheWrites;
  };
  engine = new ReviewEngine(store, new GooglePhotos(selected.id), report, state => {
    saveCache();
    chrome.runtime.sendMessage({ type: 'state', state }).catch(() => {});
  });
  activeEngine = engine;
  await engine.connect(cache);
  if (resume && previous?.account === engine.account) {
    engine.last = (await chrome.storage.session.get('undo')).undo || null;
    if (engine.last && !engine.state.decisions[engine.last.item.mediaKey]
      && !engine.state.outbox.some(job => job.item.mediaKey === engine.last.item.mediaKey)) engine.last = null;
  }
  await saveCache();
  await chrome.storage.session.set({ connection: { tabId: selected.id, account: engine.account, cacheId }, undo: engine.last });
}

async function handle(message) {
  // Previews are read-only and may load alongside a review action. Only known
  // library items are accepted; callers cannot supply arbitrary fetch URLs.
  if (message.type === 'preview') {
    try {
      if (!engine?.connected || engine.account !== message.account) throw new Error('Reconnect to load this preview.');
      const item = engine.items.find(photo => photo.mediaKey === message.mediaKey)
        || (engine.current?.mediaKey === message.mediaKey ? engine.current : null);
      if (!item?.thumb) throw new Error('Photo preview is unavailable.');
      return { ok: true, preview: await engine.google.preview(item, engine.account) };
    } catch (error) { return { ok: false, error: error.message }; }
  }
  if (message.type === 'status' && busy) return { ok: true, busy, progress, state: engine?.snapshot() || null };
  if (busy) return { ok: false, error: 'An action is still in progress. Wait before continuing.', busy: true, state: engine?.snapshot() || null };
  busy = true;
  try {
    if (message.type === 'connect') {
      await connect(message.tabId);
    } else if (message.type === 'photos') {
      await chrome.tabs.create({ url: 'https://photos.google.com/' });
    } else if (message.type === 'sources') {
      const tabs = await chrome.tabs.query({ url: 'https://photos.google.com/*' });
      return { ok: true, sources: tabs.map(tab => ({ id: tab.id, title: tab.title || 'Google Photos', url: tab.url })) };
    } else {
      if (!engine) {
        const saved = (await chrome.storage.session.get('connection')).connection;
        if (saved) await connect(saved.tabId, true);
      }
      if (engine && message.type === 'status') {
        const tabs = await chrome.tabs.query({ url: 'https://photos.google.com/*' });
        if (!tabs.some(tab => tab.id === engine.google.tabId)) await connect(engine.google.tabId, true);
        await engine.guard();
      } else if (message.type !== 'status') {
        if (!engine) throw new Error('Connect to Google Photos first.');
        if (message.type === 'decide') await engine.decide(message.action, message.mediaKey);
        else if (message.type === 'undo') await engine.undo();
        else if (message.type === 'filter') await engine.filter(message.onlyStorage);
        else if (message.type === 'skip') await engine.skip();
        else if (message.type === 'reconcile') await engine.reconcile();
        else if (message.type === 'reset' && message.confirmed === true) await engine.reset();
        else throw new Error('Unsupported extension command.');
      }
    }
    if (engine) await chrome.storage.session.set({ undo: engine.last });
    return { ok: true, state: engine?.snapshot() || null };
  } catch (error) {
    if (engine) {
      try { await engine.guard(); } catch { engine.connected = false; }
    }
    return { ok: false, error: error.message || 'Something went wrong.', state: engine?.snapshot() || null };
  } finally {
    busy = false;
    report('');
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // Only our dedicated extension page can request operations. There is no
  // page-world postMessage bridge or externally-connectable mutation endpoint.
  if (sender.id !== chrome.runtime.id || sender.url?.split('?')[0] !== reviewUrl) return false;
  if (!message || typeof message.type !== 'string') return false;
  handle(message).then(respond, error => respond({ ok: false, error: error.message }));
  return true;
});
