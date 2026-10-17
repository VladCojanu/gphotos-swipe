import { ReviewEngine } from '../src/model.js';

export function fixture(count = 16) {
  const items = Array.from({ length: count }, (_, i) => ({ mediaKey: `photo-${i}`, dedupKey: `delete-${i}`,
    timestamp: 1700000000000 - i, fileName: `${i}.jpg`, thumb: `https://photos.fife.usercontent.google.com/pw/${i}`,
    takesUpSpace: true, spaceTaken: 2000000, size: 3000000 }));
  const records = new Map();
  const locations = new Map();
  const calls = [];
  const store = { async load(account) { return structuredClone(records.get(account)); },
    async save(account, state) { records.set(account, structuredClone(state)); } };
  const google = { async health() { return { account: 'test@example.com' }; },
    async listPage() { return { items, nextPageId: null }; }, async metadata(keys) { return items.filter(item => keys.includes(item.mediaKey)); },
    async mutate(action, item) { calls.push({ action, key: item.mediaKey }); locations.set(item.mediaKey, action === 'trash' ? 'trash' : 'library'); },
    async locate(item) { return locations.get(item.mediaKey) || 'library'; } };
  return { engine: new ReviewEngine(store, google), store, google, items, records, locations, calls };
}

