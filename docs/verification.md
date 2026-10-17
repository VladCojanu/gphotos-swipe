# Verification

`npm run check` passes: 31 state, queue, preview-cache, and performance tests, the production extension build, and a browser integration suite loading the actual unpacked Manifest V3 extension.

The browser suite exercises MAIN-world requests, paginated listing, metadata parsing, authenticated private previews, keyboard repeat prevention, trash and restore, uncertain mutation outcomes, quota filtering, persistence, service-worker suspension, account isolation, confirmed reset, and desktop/mobile layout. Google responses and test photos are local fixtures; this suite does not mutate a real account.

Live verification in the user's normal Chrome profile confirmed:

- The extension is installed from `/Users/vladcojanu/workspace/gphotos-swipe/dist`, enabled, and pinned to the toolbar.
- The existing Google Photos session supports full library listing and metadata requests.
- A private photo preview loads, with file size, filename-derived type, capture date, and quota status displayed.
- Keep increments the local reviewed count; Undo restores the original count and photo.
- The final review tab is connected, the preview is loaded, both review actions are enabled, and no photos have been trashed through these checks.

The live check exposed two differences missing from the first fixtures: Google's endpoint prefix and its current image host/account-cookie requirements. The implementation and browser fixtures were corrected before completing installation.

Version 0.2.0 performance regressions were reproduced before the fix with `node --test tests/performance.test.js`: the old trash decision could not complete while Google's response was held open, and its lookahead returned no eligible photos across a metadata boundary. Both regressions now pass. The Chrome E2E test verified all ten upcoming preview requests, measured the next preloaded photo as reviewable in 31 ms while the Google response remained deliberately held open, and continued navigating before that response completed. This is a warm-cache fixture measurement, not a guarantee of production latency.

The browser test also queued two deletions, stopped the real Chrome service worker while the first request was in flight, and verified recovery without resending the interrupted request. Queue tests cover unsent cancellation, in-flight Undo, concurrent completion and Keep, legacy pending-state migration, failed persistence, account changes, and reconciliation without duplicate requests or inflated counters.

A live check also exposed a full-library rescan on worker resume. The Chrome regression reproduced it as two extra library-page requests after stopping the worker. The updated suite asserts that resuming issues no full-library listing requests, while validating the account and loading fresh decisions. The index cache is bound to the session's connection token, excludes image bytes and unused location metadata, and expires after six hours; explicit reconnect refreshes it.

The final 0.2.0 build was reloaded and connected in the user's Chrome. Live previews and review controls are ready, and the existing history and deletion statistics were retained. No real trash requests were issued as part of these performance checks.

Live trash/restore remains deliberately untested because no disposable test photo was selected. Its request shapes follow the pinned MIT Toolkit implementation, and its state transitions and network-failure recovery are covered by automated fixtures. No real photo was deleted or moved to trash during validation.


0.2.1: 35 Node tests and the Chrome MV3 integration suite pass. The browser fixture holds page two open while the first photo loads, accepts Keep and Undo, then releases pagination and checks the ten-photo preload buffer. Model regressions also cover accepting Trash before later pages finish, stopping pagination at a full buffer, resuming a partial cache through empty pages, and rejecting repeated cursors. All Google writes in these tests use fixtures.


0.2.2: Reproduced the exact misleading “Open Google Photos and sign in, then click Connect.” error in Chrome by closing the saved Photos tab, reopening Photos under a new tab ID, stopping the worker and requesting status. Recovery now probes open Photos tabs for the saved account before resuming the partial cache and durable queue. Chrome regression covers both worker restart and live-worker recovery, refuses an unrelated account, and verifies Connect still lists available tabs. All 35 Node tests and the expanded browser suite pass. Live reconnect restored review controls with 43 reviewed / 8 trashed and no queued operations; no live review actions or Google writes were issued.


0.2.3: Chrome integration checks right-arrow Keep, left-arrow Trash, matching button hints, outgoing animation direction and cleanup, no animation on failed decisions, and reduced-motion behavior. Non-blocking trash, pagination and the existing recovery/account-isolation scenarios remain covered. Google writes use fixtures only.

Explicit capture-date sorting: all 38 Node tests, production build, and Chrome integration pass. The new regression supplies unordered pages and metadata timestamps that differ from listing timestamps, then verifies the full review sequence and preview queue. The browser fixture now reverses each listing page. Cold connect completes listing and photo metadata before selection; this supersedes the earlier first-page startup and bounded-pagination behavior. Cached resumes still avoid rescanning a complete index, and trash remains non-blocking.

Repeated-preview regression: the browser test reproduced an outgoing image remaining above the next photo while its controls were already enabled. The UI now removes outgoing images on the next preview load and skips the overlay if that preview is already ready. Browser fixtures have distinct image content and assert that the loaded preview matches the current record, with no old overlay when controls enable. All 39 Node tests and the Chrome integration pass, including overlapping-page deduplication and exclusion of reviewed IDs after cached resume and fresh reconnect. Live deployment was corrected through an extension-context script; prior AppleScript calls ran without access to chrome.runtime and had not replaced the background worker. The restarted worker began full index preparation with the 262 durable reviewed decisions retained. No live review or trash actions were performed during these checks.
