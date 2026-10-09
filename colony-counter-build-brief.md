# Colony counter — implementation brief

## 1. Goal and constraints

Build a polished website for counting bacterial colonies from photographs. Users organise images into projects and freely named image groups, annotate colonies into coloured annotation groups, and save their work locally and to a Google Drive folder.

This document is the handoff to the implementing agent. The preceding work was UI exploration, not a production application. Build the actual application and validate the assumptions below.

**Non-negotiable requirements**

- All application logic, image rendering, annotation, exports and eventual detection run in the user's browser.
- No application backend, server-side processing, database server, API proxy, service account, serverless function or hosted inference service is required.
- Static HTTPS hosting is allowed and expected. Google OAuth configuration and Google's existing APIs are allowed; “no server” means no server operated for this application.
- **Google Drive integration is essential to the first complete version.** Local-only persistence, download buttons or a simulated Drive connection do not satisfy the requirement.
- Support mouse/trackpad and iPad Safari with Apple Pencil and touch. Research and test the actual interaction behaviour before claiming compatibility.
- Keep a reliable local browser copy of work. Network loss or an expired Google session must not discard annotations.
- Use general-purpose named groups. Do not impose a replicate/dilution hierarchy or require those fields.
- Retain the manual/automated origin of every annotation.

The initial product prioritises an excellent manual-counting experience. Assisted counting is a later phase; design its extension points now without making the first release depend on an unvalidated detector.

## 2. Approved layout and visual direction

Use a clean, restrained scientific workspace: light neutral surfaces, a large image area, clear typography, fine separators and restrained colour. Group colours identify annotations, not unrelated UI elements. Keep controls compact but comfortably tappable. Support responsive desktop and iPad layouts.

### Main layout

| Area | Required contents |
| --- | --- |
| Top application bar | Product name, current project, local/Drive save status, Google Drive connection/folder action. |
| Left sidebar | Projects, freely named image groups, image thumbnails or rows, image counts and import actions. |
| Image header | Current image name, image-group context, total confirmed colony count. |
| Main workspace | Large image viewport with pan/zoom and annotations. This is the dominant surface. |
| Floating toolbar | **One horizontal row**, floating over the image near its upper edge. Group selector is first. |
| Viewport lower edge | Zoom out/in, zoom level, Fit, and a compact visible/hidden count or interaction hint. |

**There must be no permanent right-hand annotation-groups sidebar.** The user explicitly rejected that layout. Do not bring it back for styling, counts or group management.

### Floating toolbar order

1. Active annotation-group selector, showing its colour and name.
2. Visibility toggle for that group.
3. Lock/unlock toggle for that group.
4. Style popover trigger.
5. Add annotation.
6. Erase annotation.
7. Pan.
8. Undo.
9. Redo.

Use labelled controls where space allows and accessible icon buttons where appropriate. Tooltips must not be the only way to understand state. Visibility and lock state must remain apparent for the selected group.

The toolbar must stay **one line**, including on iPad. On narrow phone widths, keep the group selector, visibility, lock and primary tool directly available; use a compact More popover for secondary commands instead of wrapping the toolbar. Do not shrink touch targets until they become impractical.

The left image sidebar may collapse into a drawer on smaller screens. The annotation toolbar belongs to the viewport and should not disappear when the image list closes. Controls must not trigger annotations through their overlays.

### Group selector and appearance popover

The selector lists named annotation groups with colour, count and lock/visibility state, and offers creation of a new group. Provide a compact way to rename/manage the selected group without adding a permanent side panel. New markers use the selected group.

The Style popover provides per-group settings:

- Rendering: **filled dots or circle outlines**.
- Opacity, with a labelled percentage control.
- Marker size, with a meaningful unit and consistent zoom behaviour.
- Colour.
- Labels/numbers on or off.

Persist style settings by group. Changing appearance must not change colony position, annotation origin, counts or measured image data. Decide and document whether marker size is screen-space or image-space; screen-space display markers are the starting recommendation. A display radius is not a measured biological colony radius.

## 3. Projects, images and groups

Keep two concepts distinct:

- **Image groups** organise images within a project: for example Treatment A, Batch 2, Dilution 10^-4 or Replicate 1. These are user-defined names, not fixed experiment types.
- **Annotation groups** categorise marks within an image: for example Main colonies, Small colonies or To review. They have colour, appearance, visibility and lock settings.

Provide project creation/renaming, image import, switching images, and assigning/reassigning images to named image groups. Preserve annotations when reorganising images. Support importing several images in one operation.

Each physical image/counting surface has its own annotations and count. Do not combine counts from unrelated images merely because they share a group name. Use stable IDs rather than names as identity.

Multiple colour-filter photographs of the same plate are a future extension. Keep the data model extensible to a sample with multiple image channels and alignment transforms. Do not share coordinates across different photographs until registration/alignment is established. Do not implement a speculative multi-channel editor in the first release.

## 4. Annotation behaviour

- Add a colony with a completed click/tap in Add mode; do not commit on pointer-down.
- Erase the nearest eligible marker using a comfortable, zoom-aware hit target.
- Erase affects the selected, visible, unlocked group. Make this rule apparent.
- Avoid accidental duplicate marks near existing annotations; choose a reversible interaction and test it rather than silently discarding deliberate nearby colonies.
- Store geometry in original-image coordinates. Zoom, pan, device pixel ratio and responsive resizing must not change stored positions.
- Keep counts derived from annotation records, not maintained as an independent number that can drift.
- Hiding a group removes its markers from view but keeps all its annotations in the total and exports. Visibility is not analytical exclusion.
- A hidden group cannot receive invisible edits. Explain how to show it before editing.
- Locking prevents adding, deleting, moving or otherwise modifying that group's annotations. Keep visibility toggling available. In the current design, unlock before changing group appearance as well.
- Undo/redo must not silently modify locked groups. If a history operation would do so, explain that the affected group must be unlocked.
- A batch operation, including accepting future automated suggestions, is one undoable action. Scope history clearly to the current image; switching images must not apply history to the wrong image.

Colour must not be the only group identifier: retain names and optional letter/number labels. Provide keyboard-accessible equivalents for toolbar actions and a useful textual count/status surface outside the rendered image.

## 5. Research and validate input interactions

**The implementing agent must research current browser documentation and test these behaviours. The following mappings are recommendations, not claims of proven compatibility.**

| Input | Starting interaction recommendation | Required investigation |
| --- | --- | --- |
| Mouse | Click to add/erase; Pan tool or Space+drag; wheel/trackpad zoom anchored under the pointer. | Drag thresholds, wheel delta modes, browser page zoom, middle-button handling if included. |
| Apple Pencil | Tap to add/erase according to selected tool. | Safari pen classification, cancellation, contact jitter, finger/palm overlap, and no duplicate synthetic click. |
| Touch with Pencil | Fingers pan; two fingers pinch to zoom. | Do not interpret a pinch or palm contact as a colony. Research what palm rejection the platform actually provides. |
| Touch without Pencil | Explicit touch-to-annotate mode; otherwise navigation. | One-finger drag versus tap, two-finger gestures, long-press/context-menu behaviour. |
| Keyboard | Undo/redo, tool shortcuts, temporary Space-to-pan, Escape to close popovers. | Cmd versus Ctrl, editable fields, focus handling and browser shortcut conflicts. |

Evaluate Pointer Events, `pointerType`, pointer capture, `pointercancel`, `touch-action` and passive listeners. Prefer one coherent input system over overlapping mouse/touch/pen handlers. Limit gesture suppression to the image surface; preserve normal scrolling and accessible browser behaviour elsewhere.

Test entering a second pointer after the first contact, lifting fingers in different orders, moving outside the viewport, interrupted gestures and device rotation. Clear transient pointer state after cancellation or focus loss. Pressure-sensitive input is not required for point annotations.

Research with primary documentation from MDN, WebKit/Apple and browser specifications. Record sources and tested browser/OS/device versions. Desktop emulation or automated WebKit tests do not prove real Apple Pencil support. If hardware testing is unavailable, state that limitation and leave a concrete manual test checklist.

## 6. Technical architecture — recommendations to test

Use these as a starting hypothesis. Benchmark and revise where evidence justifies it, while preserving the browser-only constraint and approved UX.

| Concern | Recommended starting point | What to validate |
| --- | --- | --- |
| UI | React + TypeScript, built as a static client application. | Accessible popovers/selectors, rendering overhead, responsive behaviour. |
| Image rendering | Native Canvas 2D, with separate image and annotation layers. | Large photos, thousands of points, high-DPI iPad memory use and redraw latency. |
| Controls | Standard HTML controls layered above canvas. | Focus, touch target size, popover clipping and event isolation. |
| View transform | One shared image-to-view transform and its inverse. | Coordinate accuracy across zoom/pan/resize/orientation and image orientation metadata. |
| Hit testing | Nearest-point query; introduce a spatial index if benchmarks justify it. | Dense/overlapping markers, hidden/locked groups and consistent touch hit targets. |
| Rendering cadence | Redraw when needed, scheduled through animation frames. | Avoid decoding/redrawing the image for every marker edit or React state update. |
| Local persistence | IndexedDB for records and image blobs; localStorage only for small preferences. | Safari quotas, eviction, private mode, failed transactions and recovery. |
| Expensive processing | Web Worker for later detection and suitable image-processing tasks. | Cancellation, progress, memory transfer and Safari compatibility. |
| Sync | Browser-side adapter that calls Google Drive directly. | OAuth lifecycle, real folder/file access, retries and conflict handling. |

Canvas is the recommendation, not a requirement to ignore alternatives. A bounded prototype may compare native Canvas 2D with SVG or a canvas library. Do not adopt a heavyweight drawing-editor framework or WebGL/WebGPU without a demonstrated need. Keep rendering independent of annotation records and interaction logic.

Avoid allocating full-original-resolution buffers for every layer. Evaluate downsampled previews, cached image sizes and device-pixel-ratio limits while retaining the original image geometry. Document supported image formats and large-image behaviour; reject unsupported formats clearly rather than displaying an empty canvas.

## 7. Essential Google Drive workflow

### User experience

1. Connect a Google account from an explicit user action.
2. Select an existing Drive folder as the project workspace, or create a workspace folder with consent.
3. Select/import images from that workspace. Reopen an existing project and its annotations when available.
4. Edit locally, with immediate local persistence and a visible dirty state.
5. Save annotations, project organisation and a summary CSV back to the selected workspace.
6. Reopen on another device/account with appropriate permissions and recover the saved project.

Expose clear states: **Saved locally**, **Changes pending**, **Saving to Drive**, **Saved to Drive**, **Reconnect required**, **Save failed**, and **Conflict needs review**. Distinguish local success from Drive success. Show the active account and workspace folder so users know where changes will go.

Local work must continue while offline or disconnected. Provide explicit Save to Drive; evaluate debounced automatic saves after the user connects. Do not promise uploads after the tab is closed, background token renewal or realtime collaboration. Never discard the local version because a remote save failed.

### Authentication and access: prove feasibility early

Google Identity Services' browser token model is a candidate for calling Google APIs directly. It requires token-expiry handling and renewed authorisation; do not assume a permanent session. Keep access tokens in memory, out of project files, logs and browser persistence. No client secret or service-account credential belongs in the shipped application. See the official [token-model guide](https://developers.google.com/identity/oauth2/web/guides/use-token-model).

Evaluate Google Picker with the least access sufficient for the actual workflow. Google's `drive.file` scope covers app-created or user-opened/shared files. **Do not assume selecting a folder grants recursive access to all existing child files.** Test folder selection, image selection, saved JSON reopening and newly added files in a real account. If full folder discovery requires a broader scope, explain the trade-off and approval/verification implications rather than quietly broadening access. See [Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth) and [web Picker integration](https://developers.google.com/workspace/drive/picker/guides/web-picker).

The browser-only requirement does not eliminate Google Cloud setup. Document the Cloud project, enabled APIs, OAuth web client, authorised origins, consent configuration, test/publishing requirements and any restricted browser API key needed by Picker. Validate the final static-host origin in Safari. Distinguish setup/configuration from an application backend.

Make a small real integration proof early: select existing images, read their bytes, write annotation JSON and CSV, update the same files, then reload and restore. A mocked adapter is useful for tests but cannot count as delivered Drive integration.

### File organisation and safe updates

Recommended output within the selected folder:

- `project.json`: project ID, image-group definitions, stable source-image IDs, output-file IDs and schema/revision metadata.
- `annotations/<stable-image-id>.json`: one annotation document per image, including group definitions and per-annotation provenance.
- `summary.csv`: project summary regenerated from annotation data.

Retain original images unchanged. Local images added to a Drive-backed project need an explicit upload/import path so the project can reopen elsewhere. Use Drive file IDs as identity; filenames are display labels and may collide or change. Avoid creating a new output file on every save or retry.

Research and implement remote revision/conflict checks. A local timestamp alone is insufficient. If a remote file changed since it was read, preserve both versions and require a review/merge or explicit overwrite choice. Validate the available Drive concurrency guarantees; do not claim atomic multi-file commits. Record enough save/revision information to detect partial uploads and rebuild stale CSV summaries.

Handle expiry/revocation, denied permission, read-only folders, deleted/moved images, duplicate names, offline transitions, quotas/rate limits, interrupted saves and repeated retries. Do not change Drive sharing permissions implicitly. A shared folder enables exchange of files; this first release is not a realtime multi-user editor.

## 8. Data contract and provenance

Define a versioned, documented JSON schema before connecting rendering and sync. Suggested separation:

| Record | Fields to preserve |
| --- | --- |
| Project | Stable ID, name, image groups, image membership, Drive workspace reference, schema version. |
| Image | Stable ID, source Drive file ID or local reference, name, oriented width/height, fingerprint/version, image-group ID. |
| Annotation group | Stable ID, name, colour, dot/circle rendering, opacity, display size/unit, labels, hidden and locked. |
| Annotation | Stable ID, image-coordinate geometry, group ID, immutable origin, creation/update times, review status and edit metadata. |

Every annotation must have `origin: "manual" | "automated"`. Do not infer origin from colour, group, rendering or the current tool. Changing groups or accepting/repositioning an automated annotation does not turn its origin into `manual`.

Track review and modification separately, for example `reviewStatus`, `reviewedAt`, `lastEditSource`, and an edit history or explicit manual-adjustment flag. Automated records should retain detector name/version, run ID, relevant parameters and confidence when meaningful. Distinguish unsupported confidence from a measured score. Origin remains attached through undo/redo, imports, exports and Drive round trips.

Store coordinates against the image's documented orientation and dimensions. Keep display marker size separate from any future detected colony radius/boundary. Detect when a Drive image was replaced and prevent blindly applying old coordinates to incompatible content.

### Summary CSV

Recommended grain: one row per image and annotation group, including zero-count groups. Include project/image-group/image/group IDs and names, source Drive file ID, confirmed total, manual-origin count, automated-origin count and updated time. Preserve hidden and locked state as metadata; neither removes annotations from counts. Keep unaccepted suggestions separate from confirmed totals. Do not repeat image totals across group rows in a way that encourages accidental double-counting.

Use UTF-8, proper CSV quoting and safe handling of spreadsheet-formula-like user text. JSON is the detailed source of truth; CSV is a derived, human-readable summary. Support local JSON/CSV export and recovery import in addition to essential Drive saving.

## 9. Assisted counting: later phase

Design for a workflow in which a user marks several representative colonies, defines a region to analyse, and asks to find similar colonies. Candidate features may include size, colour, local contrast and shape; investigate these rather than assuming one fitted template works for all plates.

The future detector must run in the browser, preferably away from the UI thread. Show suggestions separately, allow parameter adjustment and review, and accept a batch as one undoable action. Avoid duplicating existing confirmed markers. Preserve detector provenance on acceptance. Touching colonies, uneven lighting and plate edges require explicit evaluation.

For the initial release, use an honest disabled/labelled future action if appropriate. Never present fabricated detections as working automation or count pending suggestions as confirmed colonies.

## 10. Delivery sequence and acceptance checks

1. Research and prototype the risky paths first: browser-only Drive read/write/reopen and iPad input handling. Record decisions and unresolved constraints.
2. Implement the approved layout, image import, single-line floating toolbar, named groups, annotation editing and local persistence.
3. Complete real Drive synchronisation, versioned JSON and CSV export, reconnection and conflict recovery. These are release requirements, not optional follow-up work.
4. Validate interaction, persistence and large-image behaviour. Leave a documented extension point for automated detection and future image channels.

Acceptance must demonstrate:

- No annotation-group sidebar; group selection, visibility and lock are in the single-line floating toolbar.
- Group-specific dot/circle style, size, opacity, colour and labels survive reload and Drive round trips without changing counts or positions.
- Hidden groups remain in totals; locked groups cannot be modified accidentally, including through undo/redo.
- Marker positions remain correct after zoom, pan, resize and orientation changes.
- Tap versus drag/pinch/cancellation produces no accidental colonies; toolbar taps never mark the image.
- Real mouse and touch workflows work; Apple Pencil/Safari testing is recorded honestly.
- Local refresh restores work, and local-storage failure is visible rather than silently ignored.
- Real Google Drive import, save, update and reopen work from a static site without an application server.
- Expired authorisation, offline edits, partial saves and remote conflicts preserve recoverable data.
- JSON and CSV agree on counts and manual/automated origin; review/edit status never overwrites origin.
- No credentials are embedded in source or project exports; no image processing leaves the browser.

Deliver the application source, static build/setup instructions, Google configuration guide, schema examples, concise architecture decisions, and a test report with devices/browser versions, performance observations and any unverified assumptions. Do not claim completion while essential Drive functionality is still simulated or blocked.

## 11. Reference material

- Agreed visual concept in the originating workspace: `colony-single-toolbar-sketch.html`. It is an interactive design reference only, using schematic sample data; it is not production code or a compatibility test. The written layout above is sufficient if the reference is not available to the implementing agent.
- [MDN: Optimising Canvas](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas)
- [MDN: Pointer Events](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events)
- [MDN: Using Pointer Events](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events/Using_Pointer_Events)
- [Google Identity Services: token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model)
- [Google Drive: OAuth scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Google Picker: web integration](https://developers.google.com/workspace/drive/picker/guides/web-picker)

Recheck current official documentation during implementation. Treat library choices, performance expectations and gesture mappings as hypotheses to validate, while treating the product constraints and approved layout as requirements.
