import parser from '../vendor/google-photos-toolkit/parser.ts';

// This function is serialized by Chrome into the MAIN world of the selected
// Photos tab. Nothing it calls may depend on this module's scope.
export async function pageRpc(command, args, expectedAccount) {
  try {
    const wiz = window.WIZ_global_data;
    const account = typeof wiz?.oPEP7c === 'string' ? wiz.oPEP7c.trim().toLowerCase() : '';
    if (!account || !account.includes('@') || !wiz?.SNlM0e || !wiz?.eptZe) {
      throw new Error('Sign in to Google Photos, then reconnect.');
    }
    if (expectedAccount && expectedAccount !== account) throw new Error('Google account changed. Reconnect before reviewing.');
    if (command === 'health') return { ok: true, data: { account } };
    if (command === 'preview') {
      const url = new URL(args.url);
      if (url.protocol !== 'https:' || !(url.hostname.endsWith('.googleusercontent.com') || url.hostname === 'photos.fife.usercontent.google.com')) throw new Error('Unrecognized Google Photos image host.');
      const response = await fetch(url.href, { credentials: 'include', signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error('Google Photos preview is unavailable.');
      const blob = await response.blob();
      if (!blob.type.startsWith('image/') || blob.size > 12 * 1024 * 1024) throw new Error('Google Photos returned an unsupported preview.');
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Could not read the photo preview.'));
        reader.readAsDataURL(blob);
      });
      return { ok: true, data };
    }
    let rpcid, payload;
    if (command === 'list') {
      rpcid = 'lcxiM';
      payload = [args.pageId || null, args.timestamp ?? null, 500, null, 1, 3];
    } else if (command === 'uploadedList') {
      rpcid = 'EzkLib';
      payload = ['', [[4, 'ra', 0, 0]], args.pageId || null];
    } else if (command === 'metadata') {
      rpcid = 'EWgK9e';
      const keys = args.keys.map(key => [key]);
      payload = [[[keys], [[null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, [], null, null, null, null, null, null, null, null, null, null, []]]]];
    } else if (command === 'trashList') {
      rpcid = 'zy0IHe';
      payload = [args.pageId || null];
    } else if (command === 'trash' || command === 'restore') {
      if (typeof args.dedupKey !== 'string' || !args.dedupKey) throw new Error('Missing photo deletion key.');
      rpcid = 'XwAOJf';
      payload = [null, command === 'trash' ? 1 : 3, [args.dedupKey], command === 'trash' ? 3 : 2];
    } else throw new Error('Unsupported Google Photos operation.');
    const path = wiz.eptZe;
    if (typeof path !== 'string' || !/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(path)) throw new Error('Unrecognized Google Photos account path.');
    const params = new URLSearchParams({ rpcids: rpcid, 'source-path': location.pathname,
      'f.sid': String(wiz.FdrFJe), bl: String(wiz.cfb2h), pageId: 'none', rt: 'c' });
    const body = new URLSearchParams({ 'f.req': JSON.stringify([[[rpcid, JSON.stringify(payload), null, 'generic']]]), at: wiz.SNlM0e });
    const response = await fetch(`https://photos.google.com${path}data/batchexecute?${params}`, {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: body.toString(), signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`Google Photos returned HTTP ${response.status}.`);
    const text = await response.text();
    for (const line of text.split('\n')) {
      if (!line.includes('wrb.fr')) continue;
      const entries = JSON.parse(line);
      const envelope = entries.find(entry => entry[0] === 'wrb.fr' && entry[1] === rpcid);
      if (envelope?.[2]) {
        const data = JSON.parse(envelope[2]);
        if (data == null) throw new Error('Google Photos returned an empty result.');
        return { ok: true, data };
      }
    }
    throw new Error('Google Photos returned an unrecognized result.');
  } catch (error) {
    return { ok: false, error: error.message || 'Google Photos request failed.' };
  }
}

export class GooglePhotos {
  constructor(tabId) { this.tabId = tabId; }
  async request(command, args = {}, account = null) {
    const [result] = await chrome.scripting.executeScript({ target: { tabId: this.tabId }, world: 'MAIN',
      func: pageRpc, args: [command, args, account] });
    if (!result?.result?.ok) throw new Error(result?.result?.error || 'Google Photos disconnected. Reconnect to continue.');
    return result.result.data;
  }
  health() { return this.request('health'); }
  preview(item, account) {
    const url = new URL(item.thumb);
    url.pathname = url.pathname.replace(/=(?:w|h|s)\d+[^/]*$/, '') + '=w1800-h1400-no';
    return this.request('preview', { url: url.href }, account);
  }
  async listPage(account, pageId = null, timestamp = null) {
    const data = await this.request('list', { pageId, timestamp }, account);
    const result = parser(data, 'lcxiM');
    if (!result || (result.items != null && !Array.isArray(result.items))) throw new Error('Google Photos library format changed.');
    const items = result.items || [];
    if (items.some(item => typeof item.mediaKey !== 'string' || !item.mediaKey)) throw new Error('Invalid photo identifiers from Google Photos.');
    return { ...result, items };
  }
  async listUploadedPage(account, pageId = null) {
    const data = await this.request('uploadedList', { pageId }, account);
    const page = parser(data, 'EzkLib');
    if (!page || (page.items != null && !Array.isArray(page.items))) throw new Error('Google Photos library format changed.');
    const items = page.items || [];
    if (items.some(item => typeof item.mediaKey !== 'string' || !item.mediaKey)) throw new Error('Invalid photo identifiers from Google Photos.');
    return { items, nextPageId: page.nextPageId || null };
  }
  async metadata(keys, account) {
    const data = await this.request('metadata', { keys }, account);
    const result = parser(data?.[0]?.[1], 'EWgK9e');
    if (!Array.isArray(result)) throw new Error('Google Photos metadata is unavailable. Try reconnecting.');
    return result;
  }
  mutate(action, item, account) { return this.request(action, { dedupKey: item.dedupKey }, account); }
  async locate(item, account) {
    const pages = new Set();
    let pageId = null;
    do {
      const raw = await this.request('trashList', { pageId }, account);
      const page = parser(raw, 'zy0IHe');
      if (!page || (page.items != null && !Array.isArray(page.items))) throw new Error('Cannot verify Google Photos trash.');
      if (page.items?.some(photo => photo.mediaKey === item.mediaKey || photo.dedupKey === item.dedupKey)) return 'trash';
      pageId = page.nextPageId || null;
      if (pageId && pages.has(pageId)) throw new Error('Cannot verify all pages of trash. Try again.');
      pages.add(pageId);
    } while (pageId);
    // Absence from trash is not enough to conclude that a photo was restored.
    // Confirm its presence in the library around its capture timestamp.
    const seen = new Set();
    pageId = null;
    do {
      const page = await this.listPage(account, pageId, Number.isFinite(item.timestamp) ? item.timestamp + 1 : null);
      if (page.items.some(photo => photo.mediaKey === item.mediaKey)) return 'library';
      if (Number.isFinite(item.timestamp) && page.items.length && page.items.every(photo => photo.timestamp < item.timestamp)) return 'unknown';
      pageId = page.nextPageId || null;
      if (pageId && seen.has(pageId)) return 'unknown';
      seen.add(pageId);
    } while (pageId);
    return 'unknown';
  }
}
