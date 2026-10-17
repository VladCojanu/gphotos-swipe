# Google Photos ordering APIs

Verified 2026-10-17 against source and Google documentation. No live account responses were checked in this research.

## Existing browser RPC

The extension already calls `lcxiM` with `[pageId, timestamp, 500, null, 1, 3]` in `src/google.js`. This matches the vendored toolkit's pinned `getItemsByTakenDate`: its comments describe capture/EXIF ordering, backward timeline pagination, and `timestamp = null` starting at the most recent items. The last argument selects library (`1`), archive (`2`), or both (`3`); it does not select the order. The wrapper exposes no separate sort parameter. The current upstream `main` uses the same request shape. These are verified toolkit implementation details, not a Google guarantee about its undocumented RPC. [Pinned implementation](https://github.com/xob0t/Google-Photos-Toolkit/blob/cd1db961c6eacc5a3bc20304b559770ea152d930/src/api/api.ts#L114-L146), [current implementation](https://github.com/xob0t/Google-Photos-Toolkit/blob/main/src/api/api.ts).

The parser obtains the timeline timestamp from item field `[2]`, and bulk metadata timestamp from `[1][6]`. They are separate response fields. The extension's `ReviewSession.full()` in `src/model.js` gives the bulk metadata timestamp precedence. Neither parser code nor the ordering comments establish that these values always agree. Consequently, streaming timeline results can avoid a whole-library startup scan, but ordering by the subsequently displayed metadata date requires resolving or measuring any discrepancy. [Pinned parser](https://github.com/xob0t/Google-Photos-Toolkit/blob/cd1db961c6eacc5a3bc20304b559770ea152d930/src/api/parser.ts).

## Official Library API

The public `mediaItems.search` API supports `orderBy: "MediaMetadata.creation_time desc"` when a `dateFilter` is supplied; newest-first creation time is also the documented default. Its current scope is restricted to app-created media. [Search reference](https://developers.google.com/photos/library/reference/rest/v1/mediaItems/search).

Google removed full-library access scopes effective March 31, 2025. The official sorted search therefore cannot replace the browser RPC for reviewing an existing personal library. The Picker API grants access to user-selected items instead. [Google API changes](https://developers.google.com/photos/support/updates).

## Implication

The existing timeline RPC is the available path for requesting recent photos first and fetching subsequent pages as needed. Loading every photo's metadata before showing the first photo is an application choice, not a request-shape requirement. Live comparisons of timeline and bulk timestamps, including page boundaries, remain necessary before claiming that streaming preserves the displayed capture-date order for this account.

## Live probe, 2026-10-17

Ran `node scripts/test-live-ordering.mjs` against the existing signed-in session through the production `GooglePhotos` adapter. The script bundles a temporary extension module, makes read-only listing/metadata requests, publishes only aggregate results, saves reports under `artifacts/`, and removes its temporary bundle. It never invokes review decisions, trash, restore, or storage writes. Chrome must have the unpacked extension review tab and an identifiable Photos tab open. AppleScript provides DOM injection; the module itself executes with the extension permissions needed for the adapter.

The final run inspected **887 entries across three pages**, with **861 still-photo candidates** and **859 returned metadata records**. It found:

- Zero duplicate media IDs across the sampled pages.
- Zero timeline/metadata timestamp mismatches among returned comparable records.
- Zero backwards-order violations after truncating timestamps to whole seconds.
- 37 strict millisecond-order violations; the largest forward jump was **930 ms**, with all examples contained within one second.
- Two missing metadata records remained unavailable after a read-only retry.
- Re-fetching page one returned 500 items again, with three added and three removed IDs. This does not establish whether concurrent library changes or response instability caused the difference.

The strict script exited with failure, correctly rejecting exact timestamp order, complete metadata, and an identical repeated first page. These results support streaming the timeline in second-level descending order with local tie sorting, continuation-token pagination, ID deduplication, and durable reviewed-ID filtering. They do not prove behavior for the entire library or a stable snapshot. If exact millisecond order is required, retain the boundary second while fetching the next page and sort the entire tie group before showing it. Keep metadata failures separate from ordering failures and handle them without restarting review.

Latest detailed result: `artifacts/live-ordering-report.json`; timestamped reports are also retained. A preceding run confirmed the same subsecond-order pattern; another attempt encountered a metadata-response error, which motivated reporting partial metadata failures instead of discarding the ordering observations. No application behavior was changed during this probe.
