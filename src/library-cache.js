// The connection token lives in chrome.storage.session. The larger library
// index lives in IndexedDB so large libraries do not exceed session's 10 MB
// quota. No decisions, statistics, or image bytes are restored from this cache.
async function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('photos-swipe-cache', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('library', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readLibraryCache(id) {
  if (!id) return null;
  const db = await database();
  try {
    const value = await new Promise((resolve, reject) => {
      const request = db.transaction('library').objectStore('library').get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return value && Date.now() - value.savedAt < 6 * 60 * 60 * 1000 ? value : null;
  } finally { db.close(); }
}

export async function writeLibraryCache(value) {
  const db = await database();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('library', 'readwrite');
      const store = transaction.objectStore('library');
      store.clear();
      const pick = (item, keys) => Object.fromEntries(keys.filter(key => item[key] !== undefined).map(key => [key, item[key]]));
      const items = value.items.map(item => pick(item, ['mediaKey', 'dedupKey', 'thumb', 'timestamp', 'creationTimestamp', 'timezoneOffset', 'isArchived', 'isPartialUpload', 'duration', 'isLivePhoto', 'resWidth', 'resHeight']));
      const metadata = value.metadata.map(([key, info]) => [key, pick(info, ['mediaKey', 'fileName', 'timestamp', 'timezoneOffset', 'creationTimestamp', 'size', 'takesUpSpace', 'spaceTaken', 'isOriginalQuality'])]);
      store.put({ ...value, items, metadata, savedAt: Date.now() });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('Library cache write cancelled.'));
    });
  } finally { db.close(); }
}
