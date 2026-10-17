# Google Photos Swipe design

Status: implemented, tested, installed, and pinned in the user's Chrome. Live library listing, metadata, quota status, private previews, and local Keep/Undo have been verified. The review tab is connected and ready.

## User requirements

- A Chrome extension for reviewing Google Photos with a Tinder-like interaction.
- Right arrow accepts the current photo; left arrow deletes it.
- Persist totals locally: photos reviewed, photos deleted, and storage deleted in GB.
- Display the current photo's file size, file type, and capture date.
- Investigate the Google integration approach used by https://github.com/mtalcott/google-photos-deduper.

## Design tree

- Review experience: clicking the extension opens or focuses a dedicated review tab with one large photo, metadata, and stats — confirmed.
- Accept action: record a local keep decision and advance without modifying Google Photos — confirmed.
- Media scope: still photos only; skip videos — confirmed.
- Audience: personal use through Chrome's Load unpacked — confirmed.
- Google integration: reference implementation research and live read-only validation complete.
- Deletion: persist a trash request and advance immediately; send and verify in the background without per-photo confirmation; never empty trash; one-step session Undo — confirmed.
- Review queue: newest first, skip reviewed, quota-consuming photos only by default; main timeline only; reopening starts at the newest eligible unreviewed photo — confirmed.
- Statistics: count distinct photos after keep/successful trash; estimate storage removed using known quota contribution; Undo reverses the affected counters — confirmed.
- Account boundaries: local progress and stats separated by Google account — confirmed.
- Metadata: filename-derived type and explicit unknown values — confirmed.
- Keyboard and failures: one action per press, ignore repeats and presses during local decision writes; Google latency does not block further reviewing; uncertain outcomes pause the sender for reconciliation — confirmed.

## Confirmed decisions

- Q1: A dedicated extension tab contains the review interface.
- Q2: Right arrow records a local keep decision and advances; it does not modify Google Photos.
- Q3: Version one reviews still photos only, skipping videos.
- Q4: Version one is for personal use as an unpacked extension.
- Q7: Review newest first and skip previously reviewed photos. Cross-session resumption details remain open.
- Q8: Count distinct photos only after keep or successful remove actions, never on viewing alone.
- Q9: Separate progress and statistics by Google account in the current Chrome profile; display the account and pause on account changes.
- Q10: Display filename-derived file types, with Unknown when unavailable. Missing file size and capture date also remain explicitly unknown; upload date is not a substitute for capture date.
- Q11: Block deletion when a shared deletion key is detected; explain the ambiguity and allow skipping the photo.
- Q12: Require a signed-in Google Photos tab to remain open during review, using its existing session; show a reconnect state if it closes or the session expires.
- Q5: Left arrow moves the photo to Google Photos trash; the extension never empties trash. Detailed Undo behavior will be settled separately.
- Q6a: Mark quota status and enable Only photos using storage by default. This excludes known-zero and unknown-status photos from that queue without marking them reviewed; allow reviewing all photos.
- Q6b: Estimated storage removed sums known quota contributions of successfully trashed photos, rather than file bytes. Disclose unknown contributions excluded from the sum; do not claim to measure account free space. Display decimal GB.
- Q13: Support one-step Undo in the current session. Undoing trash restores the photo first; only successful restoration reverses counters and returns it to review. Undoing Keep removes its local decision and reverses its review count.
- Q14: Each physical arrow press acts once. Ignore held-key repeats and input during pending actions. Failed deletions leave the photo visible and counters unchanged. Uncertain outcomes pause for reconciliation. No per-photo confirmation dialog.
- Q15: Reopening starts at the newest eligible unreviewed photo, by capture date; do not persist a fixed queue position.
- Q16: Review the main Photos timeline; exclude archived photos and items available only through shared albums.
- Q17: Persist cumulative statistics across sessions. Provide a confirmed Reset review history and stats action scoped to the active account. Opening the extension again focuses the existing review tab.

## Quota findings

GPTK exposes nullable `takesUpSpace` and optional `spaceTaken`; the parser preserves missing status as null. This supports consuming / non-consuming / unknown classification in principle, pending live account validation.

Live metadata validation has now confirmed quota status and contribution in the user's account. Unknown and contradictory metadata handling is covered by fixtures.

## Authorized performance update

The user requested preloading the next ten photos and non-blocking deletions after using the installed extension. This supersedes the original interview's wait-for-deletion navigation and global pause behavior. Maintain the current photo plus ten eligible previews, fetch at most three at a time, and decode them before they become current. Hydrate lookahead across metadata batches and refill it in the background.

Save trash intent durably, advance after the local write, and send/verify Google operations in the background one at a time. Display outstanding requests separately; only verified deletions affect statistics. An uncertain operation pauses the sender but does not block Keep, Skip, filtering, or queueing other photos. Undo cancels an unsent operation locally or requests restoration after an in-flight trash outcome is verified. Reset waits for outstanding operations to be resolved. See [background queue ADR](adr/0002-durable-background-trash-queue.md).

Reuse a local index cache on service-worker resume after validating the account, avoiding a full-library scan on the next review. IndexedDB holds only identifiers and needed metadata; the active cache token is kept in Chrome session storage and expires after six hours. Decisions and statistics are always loaded fresh from their durable history. Explicit reconnect starts fresh pagination from the newest capture date. Image data remains in memory only.

## Agreed behavior

### Review and navigation

Clicking the extension opens or focuses one dedicated review tab. A signed-in Google Photos tab must stay open as the connection to the active account. Show that account prominently and pause on account changes, a closed source tab, or an expired session.

Show one still photo at a time, with file size, filename-derived type, capture date, and quota status. Unknown values remain visibly unknown. Review the main library by newest capture date first, excluding videos, archived photos, and items available only through shared albums. Enumerate all timeline pages, hydrate photo metadata, then explicitly sort by the final displayed capture timestamp descending. Unknown dates go last, with photo IDs breaking ties. Ignore caches created under upload ordering; keep durable review decisions and statistics. Skip previously reviewed photos.

Only photos using storage is enabled by default: include photos known to consume quota, and exclude known-zero and unknown-status photos without marking them reviewed. Allow turning this filter off to review all otherwise eligible photos. Reopening starts at the newest eligible unreviewed photo.

### Actions and recovery

- Right arrow: persist a Keep decision locally and advance; do not change the photo in Google Photos.
- Left arrow: persist a trash request and advance without per-photo confirmation. Google trash and verification run in the background. Never empty trash.
- Block deletion when a shared deletion key is detected; explain the issue and allow skipping the photo.
- Accept only one action per physical press, ignoring held-key repeats and input while a local decision is being saved. Background Google operations do not block the next review.
- Failed or uncertain deletions do not count. Pause the sender for reconciliation and let the user keep reviewing. Confirmed unapplied requests make their photos eligible again.
- One-step Undo is available in the current session. Cancel unsent trash requests locally; restore in-flight or confirmed trash before reversing counters. Do not replace the current photo if the user has continued reviewing while restoration runs. Undoing Keep removes that local decision and its review count.

### Persistence and statistics

Keep progress and cumulative statistics locally in the current Chrome profile, separately per Google account. Count each distinct photo only after Keep or a successful move to trash; viewing, filtering, skipping, and failed actions do not count. Retries and reopened photos do not inflate totals.

Display total photos reviewed, total photos moved to trash, and Estimated storage removed in decimal GB. The storage estimate sums known quota contributions of successfully trashed photos; disclose unknown contributions excluded from the sum. Undo reverses the affected totals only after its action succeeds. Provide a confirmed per-account Reset review history and stats action.

## Implementation and verification outline

1. Build a personal unpacked Chrome extension with a dedicated review tab and an isolated Google Photos integration adapter, following the existing-session GPTK approach.
2. Validate read-only listing and metadata against a signed-in account: still-photo detection, newest-first pagination, account identity, quota states, and archived-photo exclusion. Source inspection alone does not establish that these work today.
3. Implement persistent per-account decisions, queue filtering, metadata display, and counters.
4. Implement single-action keyboard handling, trash, session Undo, duplicate-tab focus, reconnect, and uncertain-outcome reconciliation.
5. Verify meaningful state transitions and failure cases: repeat presses, failed/uncertain trash requests, restore failure, duplicate decisions, account changes, missing metadata, quota-filter changes, and shared deletion keys. Build and load-check the unpacked extension. Live destructive validation requires an explicitly selected disposable photo.

The user confirmed the design and requested implementation, testing, and installation in Chrome. The implementation uses a Manifest V3 service worker, a dedicated HTML/CSS/JavaScript review tab, and `chrome.scripting.executeScript` in the selected Photos tab's MAIN world. All Google commands are handled by an extension-only service-worker endpoint; no window message bridge or remote code execution is exposed.

Google mutation intents are saved to local storage before requests are sent. Trash and restore are never automatically retried. The photo's presence in trash or the library is checked before committing the corresponding counter changes; unresolved intents survive restart. Histories and statistics describe recorded extension actions and its Undo operations, rather than continuously mirroring external changes in Google Photos.

Tests cover core state transitions and run the actual unpacked extension in a browser with local Google RPC fixtures, including authenticated private images. After the user enabled macOS automation access, the extension was installed through Chrome's normal Load unpacked workflow and pinned to the toolbar.

Live checks uncovered Google's `/_/PhotosUi/` endpoint prefix and current `photos.fife.usercontent.google.com` preview host. Fixtures were updated accordingly. Private previews must be fetched from the signed-in Photos page: direct extension-origin image requests can omit the required account session cookies. Preview commands accept only identifiers present in the current library index, enforce the expected account, restrict image hosts, bound preview size and request time, and return image data to the review tab. No extra image-host permissions are needed.

Live Keep/Undo verification returned the original photo and review count to their starting state. No real photos were moved to trash or permanently deleted. Trash, restore, timeout reconciliation, and failure paths have been exercised with browser fixtures rather than destructive operations in the user's account. See [verification](verification.md).

## Integration findings

The reference extension uses Google Photos Toolkit (GPTK) to send undocumented Google Photos web RPC requests through an existing signed-in Google Photos tab. Its bridge runs requests in the page context; no separate OAuth setup is used. See [injection](https://github.com/mtalcott/google-photos-deduper/blob/main/contents/google-photos-inject.ts) and [GPTK RPC client](https://github.com/xob0t/Google-Photos-Toolkit/blob/cd1db961c6eacc5a3bc20304b559770ea152d930/src/api/api.ts).

- Listing supports pagination and taken/uploaded date ordering. Extended metadata includes filename, file size, and quota contribution. MIME type is not exposed by the inspected metadata interface; filename-derived type needs to be labeled as inferred, with an unknown fallback. See [types](https://github.com/xob0t/Google-Photos-Toolkit/blob/cd1db961c6eacc5a3bc20304b559770ea152d930/src/types/index.ts).
- The deletion operation moves items to Google Photos trash; restoration is also available. Multiple media keys can share one deletion key, so one request can affect multiple items. See [commands](https://github.com/mtalcott/google-photos-deduper/blob/main/scripts/google-photos-commands.js) and [shared-key handling](https://github.com/mtalcott/google-photos-deduper/blob/main/lib/duplicate-detector.ts).
- File size and quota contribution differ. Some photos consume no Google account storage, so summing file bytes does not measure reclaimed quota. See [Google storage guidance](https://support.google.com/photos/answer/9284827?hl=en).
- The official Library API is limited to app-created content and cannot support this existing-library review workflow. See [API changes](https://developers.google.com/photos/support/updates).
- The reference extension is AGPL-3.0; its pinned GPTK dependency is MIT. Prefer evaluating the toolkit directly rather than assuming the extension's source has the same license.

These findings come from source inspection, not a successful live test against this user's account. The next round will settle product behavior before an integration ADR is recorded.


### Progressive library loading (0.2.1)

Connect loads the complete index and missing photo metadata before showing the first photo, so unread pages cannot introduce newer dates later. Sort the index explicitly using the final metadata dates, then fill the next-ten preview buffer asynchronously; skip previously reviewed, filtered, archived and video entries without counting them. Persist the continuation cursor and whether pagination is complete alongside the partial index. Reuse those on worker resume. Deduplicate media keys and reject repeated continuation tokens. Foreground actions use prepared photos independently of background trash requests. A cold connection takes longer because globally sorted dates require completing the index first.

Shared-key protection covers loaded entries, including archived entries, and is checked again immediately before sending a queued trash operation. A key shared with an unread entry cannot be detected before loading that page. This is the limitation of allowing trash before a complete scan; the extension does not promise globally unique deletion keys.


0.2.3: Right arrow keeps; left arrow moves to trash. Buttons follow the same spatial order. Accepted decisions animate an outgoing image for 200 ms in the matching direction while the next photo remains interactive. Failed decisions and reduced-motion settings do not animate.
