# Google Photos Swipe

A personal Chrome extension for reviewing your Google Photos library one photo at a time. Right arrow keeps a photo; left arrow moves it to Google Photos trash. The extension never empties trash.

## Install in Chrome

Requires Node.js 22+ and Chrome 120+.

```sh
npm ci
npm run build
```

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select this repository's **dist** folder.
3. Pin **Google Photos Swipe** from Chrome's Extensions menu, then click its icon.
4. Open Google Photos and sign in. In the review tab, click **Connect** and select the signed-in Photos tab. Keep that tab open during review.

Keep the repository and `dist` folder in place: Chrome loads the extension from that directory. After updating code, run `npm run build`, click the extension's Reload button on `chrome://extensions`, and reload its review tab.

## Review

- **→** keeps the current photo locally without modifying it in Google Photos.
- **←** saves a trash request locally and advances immediately. Google Photos trash and verification run in the background, one operation at a time.
- **Z / Undo** reverses the last decision in the current session. An unsent trash request is cancelled locally; an in-flight or confirmed deletion is restored in the background before subtracting its statistics.
- **Skip for now** skips a photo for this session without reviewing or counting it.

The photo slides right when kept and left when moved to trash. Animations respect reduced-motion preferences and do not delay review or background operations.

The queue contains still photos from the main library, excluding archived photos and videos. It is ordered by **date taken, newest first**, matching the date shown on each photo. The initial connection loads photo dates across the full library before sorting; large libraries take longer to prepare. Reviewed photos are skipped across sessions, and reopening starts at the newest eligible unreviewed photo.

**Only photos using storage** is enabled by default. It excludes known zero-quota and unknown-status photos without marking them reviewed. Turn it off to review all otherwise eligible photos. File type is inferred from the filename; unavailable metadata is shown as unknown.

Review starts as soon as the first eligible photo is ready. Library pages and metadata are fetched on demand, stopping once the current photo and ten upcoming eligible photos are prepared. Pages containing only reviewed or filtered photos are passed over automatically. Shared deletion keys detected among loaded entries are blocked and checked again before sending trash; matches on unread pages cannot be detected without a full scan. The next **10 eligible photos** are fetched and decoded ahead of review, including across metadata batches, with at most three preview requests in flight. Opening the extension again focuses the existing review tab.

Loaded library pages, their continuation cursor, and metadata are cached locally in IndexedDB for the current Chrome connection, for up to six hours. Worker suspension reuses that index after validating the account, and resumes incomplete pagination from its saved cursor. Decisions and stats always come from their authoritative local history, not the cache. **Reconnect** explicitly refreshes the library. If the connected Photos tab is closed and reopened, recovery finds an open tab signed into the same account before resuming; it never selects a different account automatically. No image bytes are written to the cache.

## Statistics and privacy

Progress and totals are saved in `chrome.storage.local`, separately for each signed-in Google account, in the current Chrome profile. No backend, analytics, cloud sync, or separate OAuth application is used. The extension requests host access only to Google Photos. Private previews are fetched from Google's image servers through the signed-in Photos tab, keeping those requests in the account's first-party session; the current photo and next ten previews are retained in memory for smooth navigation. `tabs`, `scripting`, and local storage permissions support connecting to the signed-in Photos tab and keeping local progress. `unlimitedStorage` avoids Chrome's normal local-storage limit on large review histories.

- **Photos reviewed** counts distinct photos after Keep or a verified move to trash. Viewing, skipping, filtering, failures, and retries do not count.
- **Moved to trash** counts verified moves performed through this extension, minus successful session Undo operations.
- **Estimated storage removed** sums known account quota contributions of those photos in decimal GB. This differs from file size and does not measure actual account free space. Unknown quota contributions are excluded and disclosed.

Statistics describe the extension's recorded decisions; changes made outside the extension are not continuously synchronized into its history. Reset history and stats clears this account's local history after confirmation; it does not restore photos or change the Google Photos library. Uninstalling the extension removes its local progress.

## Recovery

Held-key repeats and input while a local decision is being saved are ignored. Image previews must load before Keep or Trash is enabled. Background trash requests do not block reviewing, keeping, skipping, or queueing other photos. Missing or detected shared deletion keys block trash while allowing Keep or Skip. Outstanding changes are displayed separately from confirmed statistics; queued photos cannot be counted or queued twice.

Trash and restore requests are durably recorded before any mutation. If a Google operation fails or times out, the sender pauses until **Check Google Photos again** confirms whether it was applied. You can keep reviewing and queueing photos while a result needs attention. Verification never automatically repeats the mutation. After a worker restart, definitely-unsent requests can resume; interrupted sending requests require verification first. An unconfirmed location stays pending; counters remain unchanged. Resetting history is disabled while changes are outstanding. Reconnect after closing the source tab, signing out, or switching accounts.

## Verify

```sh
npm test
npm run build
npm run test:browser
```

If Playwright has no compatible local browser, run `npx playwright install chromium`. `npm run check` runs all three checks. The browser suite loads the actual unpacked MV3 extension and uses local fixtures for Google Photos RPC responses; it does not access an account or delete real photos. Screenshots are written to `artifacts/`.

Live read-only validation still requires a connected signed-in Photos tab. For a live trash/Undo check, choose a disposable test photo explicitly; fixture tests do not establish compatibility with every live Google account.

## Integration

Uses Google Photos' undocumented web RPC interface with the existing browser session, following the Google Photos Toolkit approach demonstrated by [google-photos-deduper](https://github.com/mtalcott/google-photos-deduper). The interface can change without notice. Only library listing, metadata, trash listing, move to trash, and restore are exposed by the adapter; there is no permanent-delete operation.

The vendored Toolkit parser is MIT licensed; its license and provenance are included in the built extension. See [third-party notices](vendor/README.md), [design](docs/design.md), and [integration decision](docs/adr/0001-existing-google-photos-session.md).
