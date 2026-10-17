// Bounded, decoded image cache. Current images jump ahead of queued preloads;
// dropped and failed entries never leave a permanently rejected cache entry.
export class PreviewCache {
  constructor(load, decode, concurrency = 3) {
    this.load = load;
    this.decode = decode;
    this.concurrency = concurrency;
    this.entries = new Map();
    this.waiting = [];
    this.active = 0;
  }

  get(key, priority = false) {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { key, cancelled: false };
      entry.promise = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
      entry.promise.catch(() => {});
      this.entries.set(key, entry);
      this.waiting.push(entry);
    }
    if (priority && this.waiting.includes(entry)) {
      this.waiting = [entry, ...this.waiting.filter(candidate => candidate !== entry)];
    }
    this.pump();
    return entry.promise;
  }

  retain(keys) {
    const keep = new Set(keys);
    for (const [key, entry] of this.entries) {
      if (keep.has(key)) continue;
      entry.cancelled = true;
      entry.reject(new Error('Preview was discarded.'));
      this.entries.delete(key);
    }
    this.waiting = this.waiting.filter(entry => !entry.cancelled);
  }

  pump() {
    while (this.active < this.concurrency && this.waiting.length) {
      const entry = this.waiting.shift();
      if (entry.cancelled) continue;
      this.active++;
      Promise.resolve().then(() => this.load(entry.key)).then(async data => {
        if (entry.cancelled) throw new Error('Preview was discarded.');
        // Keep the decoded Image alive until this entry leaves the window.
        entry.image = await this.decode(data);
        if (entry.cancelled) throw new Error('Preview was discarded.');
        entry.resolve(data);
      }).catch(error => {
        if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
        entry.reject(error);
      }).finally(() => { this.active--; this.pump(); });
    }
  }
}
