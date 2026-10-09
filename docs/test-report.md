# Test report

Status on 2026-10-09, at the final review on `main`. This page covers what is verified
and how, what is not verified, and the manual checks still needed on real devices and
a real Google account. Brief §10 asks for this report.

## Summary

- 346 unit tests in 26 files pass (`npx vitest run`). `npx tsc -b` and `npm run build`
  are clean.
- Agents checked desktop behaviour in **headless Google Chrome 154.0.8037.98 on macOS
  26.6.1** (Apple M-series, DPR 2), driving input over the Chrome DevTools Protocol.
- **Not tested at all:** a real iPad, Apple Pencil, Safari (macOS or iPadOS), Firefox,
  and Google Drive with a real account. Drive is implemented against the documented
  REST API and tested only against an in-memory fake. Brief §7 makes real Drive a
  release requirement, so the Drive checklist below must pass before release.

## 1. Unit tests

Run with `npx vitest run` (Node, `environment: 'node'`). IndexedDB uses
`fake-indexeddb` and Drive uses an in-memory fake (`src/storage/__tests__/fakes.ts`).

| Area | Files | Tests | What they cover |
| --- | --- | --- | --- |
| Model | `model.test.ts`, `display.test.ts` | 21 + 4 | Edit policy (locked before hidden), annotation ops, counts and `isConfirmed`, groups, image order, origin immutability, storage-owned merge, display-adjust normalisation |
| Storage: codecs | `codecs.test.ts` | 16 | Zip round trip, CSV (quoting, formula-like text, zero-count rows), validation of imported JSON |
| Storage: Drive engine | `sync.test.ts`, `drive-plumbing.test.ts` | 14 + 16 | Push and pull against the fake Drive, md5 conflict detection, partial saves, idempotent creates, token expiry, scope handling |
| Storage: repository | `repository.test.ts` | 22 | Local working copy (9), IndexedDB reconnect after `versionchange` (1), Drive-linked projects (12). Includes the delete-during-save regression from this review |
| Editor state | `editor.test.ts`, `autosave.test.ts`, `history.test.ts` | 24 + 6 + 6 | Slices, undo/redo with locked groups, autosave debounce and flush, storage updates merged without reload |
| Assisted counting | `editor.test.ts` (assist block), `review.test.ts`, `seeds.test.ts` | 10 + 15 + 6 | Accept is one undo step with a fresh run id, suggestions never in documents or counts, derived pending view, layer dropped on byte change or group delete, seed and reference-plate selection |
| Detection | `detect.test.ts`, `primitives.test.ts`, `worker.test.ts`, `scripts/eval/metrics.test.ts` | 15 + 32 + 3 + 4 | Image primitives on synthetic rasters, the three detectors on synthetic plates, worker protocol and cancellation, eval metrics |
| Viewport | `gesture`, `interaction`, `transform`, `spatial-index`, `render`, `label-layout`, `image-adjust`, `adjusted-layer`, `adjust-processor` | 28 + 16 + 18 + 15 + 6 + 7 + 16 + 10 + 1 | Tap versus drag, pinch and cancel, pen and touch policy, anchored zoom, hit testing, marker sizing, label placement, adjustment maths, adjusted-layer caching and stale-result handling |
| UI helpers | `helpers.test.ts`, `shortcuts.test.ts` | 9 + 6 | Toolbar layout (fixed order, Find similar trailing), shortcut table |

There are no component tests and no end-to-end tests in the repository. The browser
checks below were run once by agents and are not automated.

## 2. Headless browser checks (agents)

All checks used headless Chrome 154.0.8037.98 on macOS 26.6.1. Details are in
`docs/research/input-interactions.md` §4 and `docs/research/detection-results.md` §7.1.

**Viewport input:**

- Mouse, touch, wheel and keyboard input were sent through Chrome's real input
  pipeline.
- Click adds at the exact image coordinate. A drag pans and adds nothing. A 3 px
  jitter still counts as a click. Right-click adds nothing.
- Wheel and ctrl+wheel zoom keep the point under the cursor fixed to within 0.01
  image px.
- Touch: a one-finger tap adds nothing while touch annotation is off and adds while
  it is on. A two-finger pinch zooms exactly 2.0x and adds nothing. A quick
  two-finger tap adds nothing.
- Resizing to 640x1100 (rotation) keeps the centre point and the scale.
- Hidden, locked and missing groups refuse edits with the right reason.

**Display adjustments:** a 6016x4016 JPEG was adjusted through the worker path. A
40-step slider drag produced no main-thread long tasks.

**Assisted counting:** agents ran Find similar on real 6016x4016 plates in the
integrated app. They checked the review panel, region navigation, accept and undo.

**Not exercised in a browser by agents:** Google sign-in, Picker and Drive save,
because no credentials were available.

## 3. Performance observations

These numbers are indicative. Headless Chrome uses a software-like GPU path, and the
machine was shared with other jobs. None were measured on an iPad.

**Viewport** (input-interactions §4):

| Case | Result |
| --- | --- |
| 5000 markers at fit, annotation layer redraw | median about 5 ms (8–9 ms with labels on two groups) |
| Continuous zoom with 5000 markers | 16.6 ms median and 17.3 ms p95 per frame (60 fps) |
| 15,000 markers zoomed in (about 2000 visible) | median 7.4 ms per redraw |

**Display adjustments** (input-interactions §2, worker path, 6016x4016 JPEG):

| Step | Time |
| --- | --- |
| Coarsest level (0.38 Mpx) | 6–8 ms |
| Histogram | 5–10 ms |
| Fit-zoom level (1.5 Mpx) | 9–24 ms |
| Half-resolution level (6 Mpx) | 60–68 ms |
| One full-resolution 1 Mpx tile | about 10 ms |

**Detection** (detection-results §4.3 and §7.1, Apple M3 Max):

| Setup | Time |
| --- | --- |
| Node, fitter / watershed / blob detector, per image | 1.2–4.7 s / 0.4–2.0 s / 0.5–3.7 s |
| Headless Chrome, seeds on the same plate, from click to suggestions | 3.7–3.9 s |
| Headless Chrome, seeds from another plate | 4.7–5.8 s |
| Slider re-run | about 4 s |
| iPad (projected, not measured) | about 3–12 s |

- Detection misses the 1.5 s target from `automated-counting.md`.
- Peak detector raster memory is about 200 MB at 2.8 MP analysis size and about 287 MB
  at 3.3 MP, close to the roughly 300 MB iPad budget.

**Bundle size** (`npm run build`):

| Chunk | Size |
| --- | --- |
| Main JS | 311 kB (105 kB gzip) |
| Detection worker | 51 kB |
| Adjust worker | 2 kB |
| Demo repository (loaded on demand) | 7 kB |

## 4. Not verified

- **Real iPad and Apple Pencil:** pencil classification, tap reliability, hover on M2+
  iPad Pro, palm rejection, Scribble interference, and iPadOS system gestures
  cancelling input.
- **Safari (macOS and iPadOS):** page pinch, double-tap and callout suppression,
  trackpad GestureEvent pinch, the OAuth popup opened synchronously from a click,
  the Picker iframe with a restricted API key, OffscreenCanvas in the adjust worker,
  and module workers.
- **iPad memory:** a 24 MP photo (about 96 MB decoded) plus the pyramid, two canvas
  layers, adjusted tiles and a detection run (up to about 290 MB) may exceed the tab
  limit. No device measurement exists.
- **Real Google Drive account flows:** connect, pick a folder, open, save, update,
  reopen on another device, token expiry, conflicts and shared folders. See
  `docs/research/google-drive.md`, "Open items to verify with a real Google account".
- **EXIF-rotated photos in detection:** reference-plate crops use
  `createImageBitmap(blob, sx, sy, sw, sh, { imageOrientation: 'from-image' })`.
  Browsers have disagreed on whether the crop is applied before or after rotation.
- **Detector accuracy:** there is no ground truth yet. The counts in
  `detection-results.md` measure agreement between methods, not correctness.
- Firefox was not tested at all.

## 5. Manual test checklists

Record for each session: device model, OS version, browser and version, Pencil
generation, the date and the commit (`git rev-parse --short HEAD`, or the deployed
build).

### 5.1 iPad and Apple Pencil

Run the full 15-step checklist in `docs/research/input-interactions.md` §6, either in
the app or on `/viewport-demo.html`. Also record whether "Only Draw with Apple Pencil"
is on. Then check these items in the integrated app:

1. **Toolbar is one line.** In portrait and landscape the toolbar does not wrap. The
   order is group, visibility, lock, style, Add, Erase, Pan, Undo, Redo, then Find
   similar. On a narrow split view, Find similar moves into More.
2. **Toolbar taps never mark.** Tapping each toolbar button and popover with the
   Pencil and with a finger adds no marker under it.
3. **Rotation.** Zoom into a colony with markers and rotate the device. The markers
   stay on their colonies.
4. **Sidebar drawer.** Open the image list, close it, then switch images. The toolbar
   stays visible.
5. **Display adjustments.** Open the adjust popover (next to zoom) and drag
   brightness and contrast. The preview follows the drag, markers keep their colours,
   and holding compare shows the original. Then reload: the counts and positions are
   unchanged and the adjustment is kept.
6. **Memory.** On a 24 MP plate, adjust the image, zoom to full resolution and pan
   across the whole plate, then run Find similar. The tab must not reload. Repeat on
   three images in a row.
7. **Refresh restores work.** Add 10 markers, wait 1 s, then reload. All 10 are back.
   Then fill the storage or use a private window where storage is blocked: the save
   pill must show a local save error, not "Saved".

### 5.2 Google Drive

Prerequisite: an OAuth client and Picker key configured as in
`docs/google-drive-setup.md`, with the deployed origin
(`https://prathje.github.io`) and `http://localhost:5173` authorised. Use two Google
accounts (A and B) and a folder of plate photos. Run the list in desktop Chrome, macOS
Safari and iPad Safari.

1. **Connect.** Click Connect. The popup opens (Safari must not block it). The app bar
   then shows the account and nothing is saved yet.
2. **Open a folder.** Pick an existing folder with photos. All images are listed with
   thumbnails. With `VITE_GOOGLE_DRIVE_SCOPE=file`, the extra image-selection step
   appears instead.
3. **First save.** Annotate two images and press Save to Drive. The pill goes from
   "Changes pending" to "Saving to Drive" to "Saved to Drive". The folder now
   contains `project.json`, `annotations/<imageId>.json` and `summary.csv`. The
   original photos are unchanged (same Drive file IDs and md5).
4. **Update in place.** Edit again and save. The same file IDs are updated: no
   duplicates and no `project (1).json`.
5. **CSV agrees with JSON.** Open `summary.csv`. There is one row per image and group,
   zero-count groups included. The confirmed, manual and automated counts match the
   app, and hidden or locked groups are still counted.
6. **Reopen elsewhere.** In another browser or on the iPad, connect as A and open the
   folder. Annotations, groups, styles and display adjustments are restored exactly.
7. **Local image upload.** Add a local photo to the Drive project and save. It is
   uploaded into the folder and appears when the project is reopened elsewhere.
8. **Offline.** Turn off the network, edit, and check that the pill shows a pending
   or failed save while local work continues. Reconnect, save, and check that nothing
   was lost.
9. **Token expiry.** Wait over an hour, or revoke access in the Google account
   settings, then edit. The pill shows "Reconnect required" and local work is kept.
   Reconnect, then save.
10. **Conflict.** Open the project in two browsers. Save a change in browser 1, then
    a different change in browser 2. Browser 2 shows "Conflict needs review". Both
    choices (keep local, take Drive version) behave as described, and the local
    version is kept as a backup.
11. **Interrupted save.** Close the tab during "Saving to Drive", reopen and save.
    The result is consistent, with no duplicate files.
12. **Shared folder.** Share the folder with B as an editor. B opens it, edits and
    saves. A reopens and sees B's changes. Also try with B as a viewer: saving must
    fail visibly while B's local work is kept.
13. **Deleted or replaced image.** Replace a photo in Drive with a different file
    under the same name, then reopen. The image is flagged as changed and the old
    markers are not applied blindly.
14. **No credentials in outputs.** Search the exported zip, `project.json` and the
    built JS for access tokens and account email addresses. Only the public client ID
    and API key may appear, and only in the JS.
15. **Open items** from `docs/research/google-drive.md`: record the outcome of items
    1–5.

### 5.3 Assisted counting

Use plates with clear colonies. Test on desktop and on the iPad.

1. **Entry point.** Find similar is the last toolbar item, after Redo (in More on
   narrow widths), and **F** opens it. With no image, no group, or a locked or hidden
   group, the panel explains why and offers a fix.
2. **Seeds.** Mark 3–8 colonies in a group and press Find similar. Progress shows,
   and Cancel stops the run. Suggestions appear as dashed rings, and the header shows
   the confirmed total plus "+N suggested" separately.
3. **Never counted.** Before accepting, the totals, the CSV export and the saved JSON
   (after a reload) contain no suggestions. Closing the panel hides them.
4. **Reject and accept.** Tap rings to reject them, then press accept. All accepted
   marks appear at once and the count rises by exactly the accepted number.
5. **One undo step.** A single Undo removes the whole accepted batch and the
   suggestions come back. Redo restores it.
6. **Origin.** Export JSON. Accepted annotations have `origin: "automated"`, a
   `detector` block with a run ID, and a matching entry in `detectionRuns`. Move or
   regroup one: `origin` stays `automated`. In the CSV they count as automated.
7. **Locked group.** Lock the target group while suggestions are pending. Accept is
   refused, and undo or redo of the earlier accept is refused too.
8. **Display adjustments do not affect detection.** Run once with no adjustment.
   Then apply invert or a single channel view and run again with the same seeds and
   settings. The suggestion count is the same.
9. **Image switch.** Switch images during a run. The run stops and no suggestions
   from the old image appear on the new one.
10. **Reference plate.** On an image with fewer than 3 examples, choose a reference
    plate with at least 3. Suggestions appear, and the run records
    `seedImageFingerprints`.
11. **Review regions.** Previous and next move the view to each region. The
    "k or k+1?" choice replaces that region's pending set.
12. **Timing and memory on iPad.** Record the time from the click to suggestions on a
    24 MP plate, and whether the tab survives three runs in a row.

## 6. Final review findings (2026-10-09)

**Fixed, each with a regression test:**

- `fix(storage)`: a project deleted during an in-flight save was written back.
- `fix(viewport)`: a late auto-contrast histogram from the previous image was applied
  to the next image.
- `fix(viewport)`: after unmount, cancelled adjust jobs were redone on the main
  thread.
- `fix(assist)`: suggestion layers were not dropped when storage reported changed
  image bytes.

**Open issues** are listed in the final review hand-off. The main ones:

- No `beforeunload` warning while edits are unsaved.
- The detector client hangs if the worker crashes. A patch exists and is deferred
  while the detector is being retuned.
- The detector cache is keyed by image id only, so it can hold stale pixels after the
  image bytes change.
- Thumbnails that fail are never retried.
