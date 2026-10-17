// Read-only probe. Bundled and injected into the installed extension by
// test-live-ordering.mjs so it uses the same adapter and signed-in session.
import { GooglePhotos } from '../src/google.js';
import { isPhoto } from '../src/model.js';

const publish = result => { document.documentElement.dataset.swipeOrderingProbe = JSON.stringify(result); };
const validDate = value => Number.isFinite(value) && Math.abs(value) < 8.64e15;
function orderCheck(items, value) {
  let previous = null, inversions = 0, invalidDates = 0, maxForwardJumpMs = 0, inversionsOverOneSecond = 0;
  const examples = [];
  for (const item of items) {
    const timestamp = value(item);
    if (!validDate(timestamp)) { invalidDates++; continue; }
    if (previous != null && timestamp > previous) {
      inversions++;
      maxForwardJumpMs = Math.max(maxForwardJumpMs, timestamp - previous);
      if (timestamp - previous >= 1000) inversionsOverOneSecond++;
      if (examples.length < 3) examples.push({ previous: new Date(previous).toISOString(), next: new Date(timestamp).toISOString() });
    }
    previous = timestamp;
  }
  return { inversions, inversionsOverOneSecond, maxForwardJumpMs, invalidDates, examples };
}

(async () => {
  const started = performance.now();
  try {
    const tabs = await chrome.tabs.query({ url: 'https://photos.google.com/*' });
    const connection = (await chrome.storage.session.get('connection')).connection;
    const tab = tabs.find(tab => tab.id === connection?.tabId) || (tabs.length === 1 ? tabs[0] : null);
    if (!tab) throw new Error('Cannot uniquely identify the signed-in Google Photos tab.');
    const google = new GooglePhotos(tab.id);
    const { account } = await google.health();
    if (connection?.account && connection.account !== account) throw new Error('The connected account changed.');
    const items = [], pages = [], cursors = new Set();
    let cursor = null;
    for (let index = 0; index < 3; index++) {
      publish({ running: true, stage: `Fetching timeline page ${index + 1} of 3` });
      const page = await google.listPage(account, cursor);
      items.push(...page.items);
      pages.push({ items: page.items.length, order: orderCheck(page.items, item => item.timestamp),
        firstDate: validDate(page.items[0]?.timestamp) ? new Date(page.items[0].timestamp).toISOString() : null,
        lastDate: validDate(page.items.at(-1)?.timestamp) ? new Date(page.items.at(-1).timestamp).toISOString() : null });
      cursor = page.nextPageId;
      if (!cursor) break;
      if (cursors.has(cursor)) throw new Error('The API repeated a pagination token.');
      cursors.add(cursor);
    }
    const infos = new Map();
    const metadataReadErrors = [];
    const photos = items.filter(isPhoto);
    for (let start = 0; start < photos.length; start += 40) {
      publish({ running: true, stage: `Checking metadata ${Math.min(start + 40, photos.length)} / ${photos.length}` });
      try {
        for (const info of await google.metadata(photos.slice(start, start + 40).map(item => item.mediaKey), account)) infos.set(info.mediaKey, info);
      } catch (error) { metadataReadErrors.push({ batchSize: Math.min(40, photos.length - start), error: error.message }); }
    }
    publish({ running: true, stage: 'Checking first-page stability' });
    const repeated = await google.listPage(account);
    const firstPage = items.slice(0, pages[0].items);
    const missingBeforeRetry = photos.filter(item => !infos.has(item.mediaKey));
    if (missingBeforeRetry.length) {
      publish({ running: true, stage: `Rechecking ${missingBeforeRetry.length} missing metadata records` });
      for (let start = 0; start < missingBeforeRetry.length; start += 40) {
        try {
          for (const info of await google.metadata(missingBeforeRetry.slice(start, start + 40).map(item => item.mediaKey), account)) infos.set(info.mediaKey, info);
        } catch (error) { metadataReadErrors.push({ retry: true, error: error.message }); }
      }
    }
    const mismatch = photos.filter(item => infos.get(item.mediaKey)?.timestamp != null && infos.get(item.mediaKey).timestamp !== item.timestamp);
    const timeline = orderCheck(items, item => item.timestamp);
    const displayed = orderCheck(photos, item => infos.get(item.mediaKey)?.timestamp ?? item.timestamp);
    const duplicates = items.length - new Set(items.map(item => item.mediaKey)).size;
    const stableFirstPage = firstPage.length === repeated.items.length && firstPage.every((item, index) => item.mediaKey === repeated.items[index].mediaKey);
    const firstIds = new Set(firstPage.map(item => item.mediaKey));
    const repeatedIds = new Set(repeated.items.map(item => item.mediaKey));
    const firstPageStability = { exactSequence: stableFirstPage,
      originalItems: firstPage.length, repeatedItems: repeated.items.length,
      added: repeated.items.filter(item => !firstIds.has(item.mediaKey)).length,
      removed: firstPage.filter(item => !repeatedIds.has(item.mediaKey)).length,
      repeatedOrder: orderCheck(repeated.items, item => item.timestamp) };
    const missingMetadata = photos.filter(item => !infos.has(item.mediaKey)).length;
    const result = { running: false, testedAt: new Date().toISOString(), endpoint: 'lcxiM', source: 'library + archive (current adapter)',
      elapsedSeconds: Math.round((performance.now() - started) / 100) / 10,
      pages, itemsChecked: items.length, photosChecked: photos.length, metadataChecked: infos.size,
      timelineOrder: timeline, wholeSecondTimelineOrder: orderCheck(items, item => validDate(item.timestamp) ? Math.floor(item.timestamp / 1000) * 1000 : item.timestamp), displayedDateOrder: displayed, metadataReadErrors, timelineMetadataDateMismatches: mismatch.length,
      duplicateIdsAcrossPages: duplicates, stableFirstPage, firstPageStability, missingMetadata,
      missingMetadataBeforeRetry: missingBeforeRetry.length,
      pass: timeline.inversions === 0 && timeline.invalidDates === 0 && displayed.inversions === 0 && displayed.invalidDates === 0 && duplicates === 0 && stableFirstPage && missingMetadata === 0,
      scope: 'First three pages and a repeated first-page request; no photos or review history modified.' };
    publish(result);
  } catch (error) { publish({ running: false, pass: false, error: error.message }); }
})();
