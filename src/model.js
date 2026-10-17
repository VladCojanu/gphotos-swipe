export const REVIEW_ORDER = 'capture-date-desc-v2';

export function quotaStatus(item) {
  const bytes = item.spaceTaken;
  if (item.takesUpSpace === false && !(Number.isFinite(bytes) && bytes > 0)) return 'free';
  if (item.takesUpSpace === true && !(Number.isFinite(bytes) && bytes === 0)) return 'used';
  return 'unknown';
}

export function quotaBytes(item) {
  if (quotaStatus(item) === 'free') return 0;
  return quotaStatus(item) === 'used' && Number.isFinite(item.spaceTaken) && item.spaceTaken >= 0
    ? item.spaceTaken : null;
}

export function statistics(decisions = {}) {
  const stats = { reviewed: 0, trashed: 0, bytes: 0, unknown: 0 };
  for (const decision of Object.values(decisions)) {
    stats.reviewed++;
    if (decision.action === 'trash') {
      stats.trashed++;
      if (decision.bytes == null) stats.unknown++;
      else stats.bytes += decision.bytes;
    }
  }
  return stats;
}

export function isPhoto(item) {
  if (item.isArchived || item.isPartialUpload || item.duration != null) return false;
  return !/\.(mp4|mov|avi|mkv|webm|m4v|3gp|mpeg|mpg|mts)$/i.test(item.fileName || '');
}

export function eligible(item, state, onlyStorage, skipped) {
  return isPhoto(item) && !state.decisions[item.mediaKey] && !(state.outbox || []).some(job => job.item.mediaKey === item.mediaKey) && !skipped.has(item.mediaKey)
    && (!onlyStorage || quotaStatus(item) === 'used');
}

export function blankState() {
  return { version: 2, sequence: 0, decisions: {}, onlyStorage: true, pending: null, outbox: [] };
}

export class ReviewEngine {
  constructor(store, google, progress = () => {}, changed = () => {}) {
    this.store = store;
    this.google = google;
    this.progress = progress;
    this.changed = changed;
    this.account = null;
    this.state = blankState();
    this.items = [];
    this.metadata = new Map();
    this.skipped = new Set();
    this.current = null;
    this.last = null;
    this.connected = false;
    this.indexReady = false;
    this.message = '';
    this.writes = Promise.resolve();
    this.queueTask = null;
    this.warming = null;
    this.viewRevision = 0;
    this.stopped = false;
    this.instanceId = crypto.randomUUID();
    this.snapshotVersion = 0;
  }

  // Review decisions and asynchronous queue completions share this write lock.
  // Compute from the latest durable state inside the lock to prevent lost keeps,
  // lost queued operations, and counters reverting under concurrent completion.
  update(transform) {
    const task = this.writes.then(async () => {
      const next = transform(this.state);
      if (!next) return;
      next.sequence = (this.state.sequence || 0) + 1;
      await this.store.save(this.account, next);
      this.state = next;
    });
    this.writes = task.catch(() => {});
    return task;
  }

  notify() { if (!this.stopped) this.changed(this.snapshot()); }
  stop() { this.stopped = true; this.connected = false; }

  async guard() {
    if (!this.connected || this.stopped) throw new Error('Reconnect to your Google Photos tab before continuing.');
    const health = await this.google.health();
    if (health.account !== this.account) {
      this.connected = false;
      throw new Error('The Google account changed. Reconnect to review the new account.');
    }
  }

  async connect(cache = null) {
    const health = await this.google.health();
    this.account = health.account;
    const saved = await this.store.load(this.account) || blankState();
    const outbox = [...(saved.outbox || [])];
    if (saved.pending) outbox.unshift({ ...saved.pending, id: crypto.randomUUID(), status: 'uncertain' });
    this.state = { ...blankState(), ...saved, version: 2, pending: null,
      outbox: outbox.map(job => ({ ...job, status: job.status === 'queued' ? 'queued' : 'uncertain' })) };
    // Persist migration/recovery before resuming: interrupted sending operations
    // must only be verified, never automatically issued a second time.
    if (saved.pending || outbox.length) await this.update(state => ({ ...state }));
    this.items = [];
    this.metadata.clear();
    this.skipped.clear();
    this.last = null;
    this.current = null;
    this.indexReady = false;
    this.connected = true;
    this.stopped = false;
    this.message = '';
    await this.loadIndex(cache?.account === this.account ? cache : null);
    this.startQueue();
  }

  async loadIndex(cache = null) {
    // Upload-order cursors and partial indexes cannot be reused for the timeline.
    if (cache?.order !== REVIEW_ORDER) cache = null;
    this.items = cache?.items || [];
    this.cursor = cache?.cursor || null;
    this.complete = cache ? cache.complete !== false : false;
    this.pages = new Set(cache?.pages || []);
    this.pageTask = null;
    this.prepareTask = Promise.resolve();
    if (cache?.metadata) this.metadata = new Map(cache.metadata);
    this.rebuildKeys();
    // Finish enumeration and metadata before choosing a photo: an unread page
    // or a later metadata response can contain the newest capture date.
    while (!this.complete && !this.stopped) await this.loadPage();
    for (let start = 0; start < this.items.length && !this.stopped; start += 40) {
      const missing = this.items.slice(start, start + 40)
        .filter(item => isPhoto(item) && !this.metadata.has(item.mediaKey));
      if (!missing.length) continue;
      const infos = await this.google.metadata(missing.map(item => item.mediaKey), this.account);
      const byId = new Map(infos.map(info => [info.mediaKey, info]));
      for (const item of missing) this.metadata.set(item.mediaKey, byId.get(item.mediaKey) || {});
      this.progress(`Preparing photo dates: ${Math.min(start + 40, this.items.length).toLocaleString()} / ${this.items.length.toLocaleString()}`);
    }
    const dateValue = item => {
      const timestamp = this.full(item).timestamp;
      return Number.isFinite(timestamp) && Math.abs(timestamp) < 8.64e15 ? timestamp : -Infinity;
    };
    this.items.sort((a, b) => {
      const left = dateValue(a), right = dateValue(b);
      if (left !== right) return left > right ? -1 : 1;
      return a.mediaKey < b.mediaKey ? -1 : a.mediaKey > b.mediaKey ? 1 : 0;
    });
    this.current = (await this.prepare(1))[0] || null;
    this.indexReady = true;
    this.progress('');
    this.warm();
  }

  rebuildKeys() {
    const keys = new Map();
    for (const item of this.items) {
      if (!item.dedupKey) continue;
      const members = keys.get(item.dedupKey) || new Set();
      members.add(item.mediaKey);
      keys.set(item.dedupKey, members);
    }
    this.ambiguous = new Set([...keys].filter(([, members]) => members.size > 1).map(([key]) => key));
  }

  async loadPage() {
    if (this.complete || this.stopped) return;
    if (!this.pageTask) {
      this.pageTask = (async () => {
        const page = await this.google.listPage(this.account, this.cursor);
        if (this.stopped) return;
        if (page.nextPageId && this.pages.has(page.nextPageId)) throw new Error('Google Photos repeated a page. Reconnect to try again.');
        const seen = new Set(this.items.map(item => item.mediaKey));
        this.items.push(...page.items.filter(item => !seen.has(item.mediaKey) && seen.add(item.mediaKey)));
        this.cursor = page.nextPageId || null;
        this.complete = !this.cursor;
        if (this.cursor) this.pages.add(this.cursor);
        this.rebuildKeys();
        this.progress(`Loaded ${this.items.length.toLocaleString()} items`);
      })().finally(() => { this.pageTask = null; });
    }
    return this.pageTask;
  }

  available(item) {
    return isPhoto(item) && !this.state.decisions[item.mediaKey] && !this.skipped.has(item.mediaKey)
      && !this.state.outbox.some(job => job.item.mediaKey === item.mediaKey);
  }

  full(item) {
    const info = this.metadata.get(item.mediaKey);
    return { ...item, ...info, mediaKey: item.mediaKey, dedupKey: item.dedupKey, timestamp: info?.timestamp ?? item.timestamp };
  }

  cached(limit) {
    const result = [];
    for (const item of this.items) {
      if (!this.available(item)) continue;
      // Do not jump over unhydrated metadata and change the requested order.
      if (!this.metadata.has(item.mediaKey)) break;
      const full = this.full(item);
      if (eligible(full, this.state, this.state.onlyStorage, this.skipped)) result.push(full);
      if (result.length >= limit) break;
    }
    return result;
  }

  prepare(limit) {
    // Serialize hydration/pagination so foreground actions and lookahead share
    // one cursor and never race duplicate page or metadata requests.
    const task = this.prepareTask.then(() => this.prepareMore(limit));
    this.prepareTask = task.catch(() => {});
    return task;
  }

  async prepareMore(limit) {
    while (!this.stopped) {
      for (let start = 0; start < this.items.length; start += 40) {
        const ready = this.cached(limit);
        if (ready.length >= limit) return ready;
        const missing = this.items.slice(start, start + 40)
          .filter(item => this.available(item) && !this.metadata.has(item.mediaKey));
        if (missing.length) {
          const infos = await this.google.metadata(missing.map(item => item.mediaKey), this.account);
          if (this.stopped) return [];
          const byId = new Map(infos.map(info => [info.mediaKey, info]));
          for (const item of missing) this.metadata.set(item.mediaKey, byId.get(item.mediaKey) || {});
        }
      }
      const ready = this.cached(limit);
      if (ready.length >= limit || this.complete) return ready;
      await this.loadPage();
    }
    return [];
  }

  warm() {
    if (!this.warming && !this.stopped) {
      this.warming = this.prepare(11).then(() => this.notify()).catch(() => {
        // Lookahead failures must not block a cached current photo. The next
        // foreground request can retry any metadata that is still missing.
      }).finally(() => { this.warming = null; });
    }
    return this.warming;
  }

  async next() {
    const ready = this.cached(1);
    if (ready.length) {
      this.current = ready[0];
      this.warm();
    } else {
      this.current = (await this.prepare(1))[0] || null;
      this.warm();
    }
  }

  async decide(action, mediaKey) {
    if (!['keep', 'trash'].includes(action)) throw new Error('Unknown review action.');
    if (!this.current || this.current.mediaKey !== mediaKey) throw new Error('This photo has changed. Try again.');
    if (!this.available(this.current)) throw new Error('This photo has already been reviewed or queued.');
    this.viewRevision++;
    await this.guard();
    const item = this.current;
    if (action === 'trash') {
      if (!this.indexReady || !item.dedupKey || this.ambiguous.has(item.dedupKey)) {
        throw new Error('This photo has a missing or shared deletion key. Skip it or keep it; deletion is blocked.');
      }
      const job = { id: crypto.randomUUID(), kind: 'trash', item, status: 'queued', startedAt: Date.now() };
      await this.update(state => ({ ...state, outbox: [...state.outbox, job] }));
      this.last = { action, item, jobId: job.id };
      this.message = 'Queued for trash';
    } else {
      await this.update(state => ({ ...state, decisions: { ...state.decisions, [mediaKey]: { action, bytes: null, at: Date.now() } } }));
      this.last = { action, item };
      this.message = 'Kept photo';
    }
    await this.next();
    this.startQueue();
  }

  async undo() {
    if (!this.last) throw new Error('There is no decision to undo in this session.');
    this.viewRevision++;
    await this.guard();
    const { action, item } = this.last;
    const returnRevision = this.viewRevision;
    let immediate = false;
    if (action === 'keep') {
      await this.update(state => {
        const decisions = { ...state.decisions };
        delete decisions[item.mediaKey];
        return { ...state, decisions };
      });
      immediate = true;
    } else {
      await this.update(state => {
        const job = state.outbox.find(job => job.item.mediaKey === item.mediaKey);
        if (job?.status === 'queued' && job.kind === 'trash') {
          immediate = true;
          return { ...state, outbox: state.outbox.filter(candidate => candidate.id !== job.id) };
        }
        if (job) {
          return { ...state, outbox: state.outbox.map(candidate => candidate.id === job.id
            ? { ...candidate, undoRequested: true, returnRevision } : candidate) };
        }
        if (!state.decisions[item.mediaKey]) { immediate = true; return null; }
        return { ...state, outbox: [...state.outbox, { id: crypto.randomUUID(), kind: 'restore', item, status: 'queued', returnRevision, startedAt: Date.now() }] };
      });
    }
    this.last = null;
    if (immediate) this.current = item;
    this.message = immediate ? 'Decision undone' : 'Undo queued; the photo will return after restoration';
    this.startQueue();
  }

  startQueue() {
    if (this.queueTask || this.stopped || !this.connected || !this.state.outbox.some(job => job.status === 'queued')) return this.queueTask;
    if (this.state.outbox.some(job => job.status !== 'queued')) return null;
    let failed = false;
    this.queueTask = this.drain().catch(error => {
      failed = true;
      this.message = error.message || 'A queued operation needs verification.';
      this.notify();
    }).finally(() => {
      this.queueTask = null;
      if (!this.stopped) this.notify();
      if (!failed) this.startQueue();
    });
    return this.queueTask;
  }

  async drain() {
    while (!this.stopped && this.connected) {
      if (this.state.outbox.some(job => job.status === 'uncertain')) return;
      const candidate = this.state.outbox.find(job => job.status === 'queued');
      if (!candidate) return;
      try {
        await this.guard();
        let claimed;
        await this.update(state => {
          const current = state.outbox.find(job => job.id === candidate.id);
          if (current?.status !== 'queued') return null;
          claimed = { ...current, status: 'sending' };
          return { ...state, outbox: state.outbox.map(job => job.id === claimed.id ? claimed : job) };
        });
        if (!claimed || this.stopped) continue;
        this.notify();
        // No retries: the durable sending state becomes uncertain on restart.
        if (claimed.kind === 'trash' && this.ambiguous.has(claimed.item.dedupKey)) throw new Error('A shared deletion key was detected. This operation was not sent.');
        await this.google.mutate(claimed.kind, claimed.item, this.account);
        if (this.stopped) return;
        const location = await this.google.locate(claimed.item, this.account);
        if (this.stopped) return;
        const expected = claimed.kind === 'trash' ? 'trash' : 'library';
        if (location !== expected) throw new Error('Google has not confirmed the queued operation. Check its result.');
        await this.finish(claimed.id, location);
      } catch (error) {
        if (this.stopped) return;
        await this.update(state => ({ ...state, outbox: state.outbox.map(job => job.id === candidate.id
          ? { ...job, status: 'uncertain', error: error.message } : job) }));
        this.message = 'A queued operation needs verification. You can keep reviewing.';
        this.notify();
        return;
      }
    }
  }

  async finish(id, location) {
    let completed;
    let applied = false;
    await this.update(state => {
      const job = state.outbox.find(candidate => candidate.id === id);
      if (!job) return null;
      completed = job;
      const decisions = { ...state.decisions };
      applied = (job.kind === 'trash' && location === 'trash') || (job.kind === 'restore' && location === 'library');
      if (applied && job.kind === 'trash') decisions[job.item.mediaKey] = { action: 'trash', bytes: quotaBytes(job.item), at: Date.now() };
      if (applied && job.kind === 'restore') delete decisions[job.item.mediaKey];
      let outbox = state.outbox.filter(candidate => candidate.id !== id);
      if (applied && job.kind === 'trash' && job.undoRequested) {
        outbox = [{ ...job, id: crypto.randomUUID(), kind: 'restore', status: 'queued', undoRequested: false }, ...outbox];
      }
      return { ...state, decisions, outbox };
    });
    if (!completed || this.stopped) return;
    if (applied && completed.kind === 'restore') {
      if (completed.returnRevision === this.viewRevision) this.current = completed.item;
      this.message = 'Photo restored';
    } else if (!applied) {
      this.message = `${completed.kind === 'trash' ? 'Trash' : 'Restore'} was not applied. Counters are unchanged.`;
      if (!this.current) await this.next();
      if (completed.kind === 'restore' && !this.last) this.last = { action: 'trash', item: completed.item };
      if (completed.kind === 'trash' && completed.undoRequested && completed.returnRevision === this.viewRevision) {
        this.current = completed.item;
        this.message = 'Decision undone';
      }
    }
    this.warm();
    this.notify();
  }

  async reconcile() {
    await this.guard();
    const jobs = this.state.outbox.filter(job => job.status === 'uncertain' || (job.status === 'sending' && !this.queueTask));
    for (const job of jobs) {
      const location = await this.google.locate(job.item, this.account);
      if (!['trash', 'library'].includes(location)) throw new Error('Google has not confirmed where this photo is. Check again shortly.');
      await this.finish(job.id, location);
    }
    this.startQueue();
  }

  async filter(onlyStorage) {
    this.viewRevision++;
    await this.guard();
    await this.update(state => ({ ...state, onlyStorage: !!onlyStorage }));
    await this.next();
  }

  async skip() {
    if (!this.current) throw new Error('There is no photo available to skip.');
    this.viewRevision++;
    await this.guard();
    this.skipped.add(this.current.mediaKey);
    this.message = 'Skipped for this session';
    await this.next();
  }

  async reset() {
    if (this.state.outbox.length) throw new Error('Finish or resolve pending operations before resetting history.');
    this.viewRevision++;
    await this.guard();
    await this.update(state => ({ ...blankState(), sequence: state.sequence, onlyStorage: state.onlyStorage }));
    this.last = null;
    this.skipped.clear();
    this.message = 'Review history and stats reset for this account';
    await this.next();
  }

  snapshot() {
    const upcoming = [];
    if (this.current) {
      const start = this.items.findIndex(item => item.mediaKey === this.current.mediaKey) + 1;
      for (let i = start; i < this.items.length; i++) {
        const item = this.items[i];
        if (!this.available(item)) continue;
        if (!this.metadata.has(item.mediaKey)) break;
        const full = this.full(item);
        if (eligible(full, this.state, this.state.onlyStorage, this.skipped)) upcoming.push({ thumb: item.thumb, mediaKey: item.mediaKey });
        if (upcoming.length === 10) break;
      }
    }
    const uncertain = this.state.outbox.find(job => job.status === 'uncertain' || (job.status === 'sending' && !this.queueTask));
    return {
      connected: this.connected, account: this.account, current: this.current, upcoming,
      instanceId: this.instanceId, revision: ++this.snapshotVersion,
      stats: statistics(this.state.decisions), onlyStorage: this.state.onlyStorage,
      pending: uncertain ? { kind: uncertain.kind, fileName: uncertain.item.fileName, error: uncertain.error } : null,
      pendingCount: this.state.outbox.length,
      canUndo: !!this.last,
      canTrash: !!this.current?.dedupKey && this.indexReady && !this.ambiguous?.has(this.current.dedupKey),
      loaded: this.indexReady, complete: this.complete, total: this.items.length, message: this.message,
    };
  }
}
