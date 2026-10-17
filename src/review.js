import { quotaStatus, quotaBytes } from './model.js';
import { PreviewCache } from './previews.js';

const $ = id => document.getElementById(id);
let state = null, working = false, remoteBusy = false, imageReady = false, error = '', imageKey = null;
const number = new Intl.NumberFormat();
const date = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
let deferredState = null;
let previewAccount = null;
const previews = new PreviewCache(async key => {
  const [account, mediaKey] = JSON.parse(key);
  const result = await chrome.runtime.sendMessage({ type: 'preview', mediaKey, account });
  if (!result?.ok || typeof result.preview !== 'string' || !result.preview.startsWith('data:image/')) throw new Error('Photo preview is unavailable.');
  return result.preview;
}, async data => {
  const image = new Image();
  image.src = data;
  await image.decode();
  return image;
});
function previewKey(mediaKey) { return JSON.stringify([state.account, mediaKey]); }

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return 'Unknown';
  if (value < 1e3) return `${value} B`;
  if (value < 1e6) return `${(value / 1e3).toFixed(1)} KB`;
  if (value < 1e9) return `${(value / 1e6).toFixed(1)} MB`;
  return `${(value / 1e9).toFixed(2)} GB`;
}
function fileType(name) {
  const ext = name?.match(/\.([a-z0-9]+)$/i)?.[1]?.toUpperCase();
  if (!ext) return 'Unknown';
  return ({ JPG: 'JPEG', JPEG: 'JPEG', PNG: 'PNG', HEIC: 'HEIC', HEIF: 'HEIF', WEBP: 'WebP', GIF: 'GIF', AVIF: 'AVIF', DNG: 'DNG', TIF: 'TIFF', TIFF: 'TIFF' })[ext] || ext;
}
function photoUrl(item) {
  try {
    const url = new URL(item.thumb);
    if (url.protocol !== 'https:' || !(url.hostname.endsWith('.googleusercontent.com') || url.hostname === 'photos.fife.usercontent.google.com')) return null;
    return `${url.href.split('=')[0]}=w1800-h1400-no`;
  } catch { return null; }
}
function showNotice(message, kind = '') {
  $('notice').textContent = message;
  $('notice').className = `notice ${kind}`;
}
function updateControls() {
  const busy = working || remoteBusy;
  const ready = state?.connected && state.current && imageReady && !busy;
  $('keep').disabled = !ready;
  $('trash').disabled = !ready || !state.canTrash;
  $('skip').disabled = !state?.connected || !state.current || busy;
  $('undo').disabled = !state?.connected || !state.canUndo || busy;
  $('filter').disabled = !state?.connected || busy;
  $('reset').disabled = !state?.connected || !!state.pendingCount || busy;
  $('connect').disabled = busy;
  $('reconcile').disabled = busy || !state?.connected;
}
function render() {
  const connected = !!state?.connected;
  if (previewAccount !== state?.account) { previews.retain([]); imageKey = null; imageReady = false; previewAccount = state?.account; }
  $('account').textContent = state?.account || 'Not connected';
  $('connection-dot').classList.toggle('connected', connected);
  $('connect').textContent = connected ? 'Reconnect' : 'Connect';
  const stats = state?.stats || { reviewed: 0, trashed: 0, bytes: 0, unknown: 0 };
  $('reviewed').textContent = number.format(stats.reviewed);
  $('trashed').textContent = number.format(stats.trashed);
  $('storage').textContent = (stats.bytes / 1e9).toFixed(3);
  $('unknown').textContent = stats.unknown ? `${number.format(stats.unknown)} trashed photo(s) with unknown quota size excluded` : 'Based on known account storage usage';
  $('filter').checked = state?.onlyStorage ?? true;
  $('pending').hidden = !state?.pending;
  $('queue-status').hidden = !state?.pendingCount;
  $('queue-status').textContent = state?.pendingCount ? `${state.pendingCount} change(s) queued or being verified · stats update after confirmation` : '';
  const item = connected ? state?.current : null;
  $('photo').hidden = !item;
  $('photo-caption').hidden = !item;
  $('empty').hidden = !!item;
  $('open-photos').hidden = connected;
  $('view-google').hidden = !item;
  $('blocked').hidden = !item || state.canTrash;
  $('queue-label').textContent = item ? 'Current photo' : 'Review queue';
  if (!item) {
    previews.retain([]);
    imageKey = null;
    imageReady = false;
    $('photo').removeAttribute('src');
    $('image-loading').hidden = true;
    $('empty-title').textContent = state?.pending ? 'Verification needed' : connected && state.loaded ? (state.complete ? 'Review complete' : 'Loading photos…') : connected ? 'Loading photos…' : 'Connect Google Photos';
    $('empty-description').textContent = state?.pending ? 'Use the verification button below to resolve the pending operation.' : connected && state.loaded ? (!state.complete ? 'Loading the next photos. Reconnect if loading was interrupted.' : state.onlyStorage ? 'No unreviewed photos with known storage usage remain. Turn off the storage filter to review other photos.' : 'No eligible unreviewed photos remain. Skipped photos return in a new session.') : 'Open a signed-in Google Photos tab, then select Connect. Keep the tab open while reviewing.';
    $('filename').textContent = 'No photo selected';
    for (const id of ['file-size', 'file-type', 'taken', 'quota-status']) $(id).textContent = '—';
    $('quota-size').textContent = '—';
  } else {
    $('filename').textContent = item.fileName || 'Untitled photo';
    $('file-size').textContent = formatBytes(item.size);
    $('file-type').textContent = fileType(item.fileName);
    const taken = Number.isFinite(item.timestamp) && Math.abs(item.timestamp) < 8.64e15 ? date.format(new Date(item.timestamp)) : 'Unknown';
    $('taken').textContent = taken;
    $('photo-date').textContent = taken;
    const quota = quotaStatus(item);
    $('quota-status').textContent = ({ used: 'Counts toward storage', free: 'Doesn’t count toward storage', unknown: 'Quota status unknown' })[quota];
    const bytes = quotaBytes(item);
    $('quota-size').textContent = quota === 'free' ? 'Excluded from storage estimates.' : bytes != null ? `${formatBytes(bytes)} of your account storage` : 'Unknown contributions are excluded from storage estimates.';
    $('view-google').href = `https://photos.google.com/photo/${encodeURIComponent(item.mediaKey)}?authuser=${encodeURIComponent(state.account)}`;
    if (imageKey !== item.mediaKey) {
      imageKey = item.mediaKey;
      imageReady = false;
      try {
        const original = new URL(item.thumb);
        $('photo').dataset.previewHost = original.hostname;
      }
      catch { $('photo').dataset.previewHost = `Unavailable (${typeof item.thumb})`; }
      const src = photoUrl(item);
      if (src) {
        const key = imageKey;
        $('image-loading').textContent = 'Loading photo…';
        $('image-loading').hidden = false;
        $('photo').removeAttribute('src');
        previews.get(previewKey(item.mediaKey), true).then(objectUrl => {
          if (imageKey === key && state?.connected) $('photo').src = objectUrl;
        }).catch(() => {
          if (imageKey !== key) return;
          $('image-loading').textContent = 'Preview unavailable. Skip this photo or open it in Google Photos.';
          $('image-loading').hidden = false;
          updateControls();
        });
      } else {
        $('photo').removeAttribute('src');
        $('image-loading').textContent = 'Preview unavailable. Skip this photo or open it in Google Photos.';
        $('image-loading').hidden = false;
      }
    }
    const keys = [previewKey(item.mediaKey), ...(state.upcoming || []).map(upcoming => previewKey(upcoming.mediaKey))];
    previews.retain(keys);
    for (const upcoming of state.upcoming || []) previews.get(previewKey(upcoming.mediaKey));
  }
  updateControls();
  if (error) showNotice(error, 'error');
  else if (!working && !remoteBusy) showNotice(state?.message || '');
}

async function send(type, data = {}, quiet = false) {
  if (working && type !== 'status') return;
  if (!quiet) { working = true; error = ''; updateControls(); }
  try {
    const result = await chrome.runtime.sendMessage({ type, ...data });
    if (result?.state !== undefined && (!state || !result.state || result.state.instanceId !== state.instanceId || result.state.revision > state.revision)) state = result.state;
    remoteBusy = !!result?.busy;
    if (result?.ok && result.state?.connected) error = '';
    if (!result?.ok) error = result?.error || 'The extension did not respond. Reload this tab.';
    if (result?.progress) showNotice(result.progress, 'busy');
    return result;
  } catch (err) {
    error = err.message || 'The extension disconnected. Reload this tab.';
  } finally {
    if (!quiet) working = false;
    if (deferredState && deferredState.instanceId === state?.instanceId && deferredState.revision > state.revision) state = deferredState;
    deferredState = null;
    render();
  }
}

$('photo').addEventListener('load', () => { document.querySelectorAll('.swipe-out').forEach(image => image.remove()); imageReady = true; $('image-loading').hidden = true; updateControls(); });
$('photo').addEventListener('error', () => { imageReady = false; $('image-loading').textContent = 'Preview unavailable. Skip this photo or open it in Google Photos.'; $('image-loading').hidden = false; updateControls(); });
function decide(action) {
  if (working || remoteBusy || !imageReady || !state?.current) return;
  const account = state.account;
  const outgoing = $('photo').cloneNode();
  outgoing.removeAttribute('id');
  outgoing.alt = '';
  outgoing.setAttribute('aria-hidden', 'true');
  send('decide', { action, mediaKey: state.current.mediaKey }).then(result => {
    // Animate only accepted decisions. A separate image lets the next photo
    // become usable immediately, without waiting for the visual transition.
    if (!result?.ok || imageReady || state?.account !== account || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const direction = action === 'keep' ? 1 : -1;
    outgoing.className = 'swipe-out';
    outgoing.dataset.direction = action === 'keep' ? 'right' : 'left';
    $('viewer').append(outgoing);
    const animation = outgoing.animate([
      { transform: 'translateX(0) rotate(0deg)', opacity: 1 },
      { transform: `translateX(${direction * 110}%) rotate(${direction * 6}deg)`, opacity: 0 },
    ], { duration: 200, easing: 'ease-in', fill: 'forwards' });
    animation.finished.then(() => outgoing.remove(), () => outgoing.remove());
  });
}
$('keep').onclick = () => decide('keep');
$('trash').onclick = () => decide('trash');
$('undo').onclick = () => send('undo');
$('skip').onclick = () => send('skip');
$('reconcile').onclick = () => send('reconcile');
$('filter').onchange = event => send('filter', { onlyStorage: event.target.checked });
$('open-photos').onclick = $('dialog-open').onclick = () => send('photos');
$('connect').onclick = async () => {
  const result = await send('sources');
  if (!result?.ok) return;
  $('source-tabs').replaceChildren(...result.sources.map(tab => {
    const option = document.createElement('option');
    option.value = tab.id;
    option.textContent = `${tab.title} — ${new URL(tab.url).pathname}`;
    return option;
  }));
  if (!result.sources.length) {
    const option = document.createElement('option');
    option.textContent = 'Open Google Photos first, then reopen this dialog';
    $('source-tabs').append(option);
  }
  $('dialog-connect').disabled = !result.sources.length;
  $('connection-dialog').showModal();
};
$('dialog-connect').onclick = () => {
  const tabId = Number($('source-tabs').value);
  previews.retain([]); imageKey = null; imageReady = false;
  $('connection-dialog').close();
  send('connect', { tabId });
};
$('reset').onclick = () => { $('reset-account').textContent = state.account; $('reset-dialog').showModal(); };
$('cancel-reset').onclick = () => $('reset-dialog').close();
$('confirm-reset').onclick = () => { $('reset-dialog').close(); send('reset', { confirmed: true }); };

window.addEventListener('keydown', event => {
  if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || document.querySelector('dialog[open]')) return;
  if (event.target.closest('input, select, textarea, [contenteditable="true"]')) return;
  const button = ({ ArrowLeft: 'trash', ArrowRight: 'keep', z: 'undo', Z: 'undo' })[event.key];
  if (button) {
    event.preventDefault();
    if (!$(button).disabled) $(button).click();
  }
});
chrome.runtime.onMessage.addListener(message => {
  if (message.type === 'state' && message.state?.instanceId === state?.instanceId) {
    if (working) {
      if (!deferredState || message.state.revision > deferredState.revision) deferredState = message.state;
    } else if (message.state.revision > state.revision) { state = message.state; render(); }
  }
  if (message.type === 'progress' && working) showNotice(message.message || 'Working…', 'busy');
});
send('status');
setInterval(() => { if (!working && !document.hidden && !document.querySelector('dialog[open]')) send('status', {}, true); }, 4000);
