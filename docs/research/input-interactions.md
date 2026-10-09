# Viewport input, rendering and iPad behaviour

Status: implemented in `src/viewport/`. Desktop Chrome behaviour was tested with automated pointer, touch, wheel and keyboard input. **Apple Pencil and iPad Safari have not been tested on hardware**; see the manual checklist at the end.

Sources were checked in October 2026. Where a claim could not be confirmed from a primary source, it says so.

## 1. Module layout

| Module | Role | Knows about |
| --- | --- | --- |
| `transform.ts` | Pure image/screen transform and its inverse; fit (with insets), clamped zoom anchored at a point, pan, resize, wheel classification | numbers only |
| `gesture.ts` | Pure pointer state machine. Normalised pointer samples go in, intents come out (`tap`, `pan`, `pinch`, `hover`, `hoverEnd`) | pointer types and thresholds; no DOM, no annotations |
| `spatial-index.ts` | `PointIndex` interface with linear-scan and uniform-grid implementations | annotation coordinates |
| `interaction.ts` | Editing rules: tap -> add / erase / blocked, hover preview, near-duplicate cue, erase hit radius | groups, tools, `PointIndex`, transform |
| `render.ts` | Canvas 2D drawing of the image layer (mipmap pyramid) and the annotation layer (sprites, labels). Backing-store cap | ctx, view, data; no input |
| `Viewport.tsx` | DOM wiring: canvases, listeners, rAF scheduling, ResizeObserver, props/callbacks | all of the above |

Stored coordinates are image pixels. Zoom, pan, DPR and resizing change only `ViewState`. Positions are always converted with `screenToImage` and are never stored in screen units.

## 2. Decisions

### Markers
- **Size is in screen space.** `AnnotationGroup.size` is a radius in CSS px, constant at any zoom; `labelSize` is too, clamped to 8–32 px. A display radius is not a colony measurement.
- **Legibility.** Every marker has a thin contrasting outline: dark for light colours, white for dark colours (WCAG relative luminance > 0.4). This keeps markers readable on pale agar and on dark or blood agar. Labels are white with a dark halo. The active group is drawn last, with a slightly heavier outline.
- **Drawing method.** Each group style is rendered once into a small sprite at device resolution, then blitted unscaled at whole device pixels with 3-argument `drawImage` at identity transform. Measured in headless Chrome 154 on 5000 markers (record time, then forced raster):
  - one path with 5000 arcs: 0.6 ms / 90 ms;
  - chunked paths of 256: 0.5 ms / 58 ms;
  - scaled sprite blits: 14 ms / 4.6 ms;
  - unscaled integer blits: 4.8 ms / 0.9 ms (chosen).

  Snapping moves a marker by at most half a device pixel, which is display only.
- **Hidden groups** are not drawn. Their annotations still count in totals, which are the app shell's responsibility.

### Thresholds and hit targets
| Input | Drag threshold | Minimum erase radius |
| --- | --- | --- |
| Mouse | 4 CSS px | 12 CSS px |
| Pen | 8 CSS px (contact jitter) | 22 CSS px |
| Touch | 10 CSS px | 22 CSS px |

- The erase radius is `max(marker radius, minimum)` in screen space, divided by the zoom scale, so it is zoom-aware.
- Only annotations in the active group are eligible, and only if that group is visible and unlocked.
- A tap uses the **contact-down position**, so lift-off jitter from a rolling pen or finger cannot move the point.
- A finger held longer than 500 ms is not a tap, so a resting hand does not add marks when touch annotation is on.

### Pen and touch policy
- **Nothing commits on pointerdown.** A tap is emitted on pointerup only if the pointer stayed within its drag threshold.
- **Pen drag beyond the threshold pans and never annotates.** This makes a sloppy stroke harmless and gives one-handed navigation. The alternative, ignoring the drag, gives no feedback.
- **Fingers only navigate** when `touchAnnotates` is false (the default) or a pen was seen in the last 10 s. Pen hover events count as "seen". Navigation is one-finger pan, two-finger pinch plus pan.
- **When `touchAnnotates` is true**, a one-finger tap annotates. A second finger cancels the pending tap and starts a pinch. After a multi-finger gesture, no tap is emitted until every finger has lifted. If one pinch finger lifts, the remaining finger keeps panning.
- **Palm handling:**
  - touches that arrive while a pen is down are ignored;
  - a pen contact cancels any pending or ongoing finger gesture without tapping, which covers a palm landing before the pen;
  - contacts reported larger than 60 CSS px are ignored;
  - a third finger is ignored.
- **Cleanup.** `pointercancel`, `lostpointercapture`, window `blur` and `visibilitychange` (hidden) all clear transient state without emitting a tap.
- **Mouse:**
  - primary button: click adds or erases; drag beyond 4 px pans in any tool;
  - Pan tool, Space held, or middle button: pans immediately;
  - right button: ignored, and the context menu is suppressed on the surface.

### Near-duplicate handling
The brief asks to avoid accidental duplicates without silently discarding deliberate neighbours. Adds always go through, because they are undoable in the app. If the new point is within one marker radius in screen space (minimum 6 px) of an existing visible marker in any group, a brief amber ring appears at both points. The marker is not refused because two touching colonies are real and common. Refusing them would silently lose counts, while the cue makes an accidental double tap obvious and one undo fixes it.

The rings are positioned with `left`/`top` and scale about their own centre. They are removed as soon as the view moves. Under `prefers-reduced-motion` they are static rings removed by a timer, which also works when the app's global reduced-motion rule sets `animation-duration: 0.01ms`.

> **Bug found and fixed:** a flying circle while adding. The first version positioned the ring with `transform: translate()` and animated the individual `scale` property. Per CSS Transforms 2, `scale` is applied before the `transform` list, so the translate offset was scaled too. The ring slid from 0.7x to 1.8x its position, measured from the viewport's top-left corner. Measured before the fix, a click at (1076, 640) put the ring centre at (834, 451), then (1616, 1062) after 500 ms. After the fix it stays at (1076, 640), confirmed in both the demo and the integrated app.

### Hover preview and cursor
- Mouse and Apple Pencil hover (`pointermove` with `buttons === 0`) show a DOM ring:
  - **Add:** a dashed ring in the group colour where the point would land.
  - **Erase:** a red ring around the marker that would be erased, or a dashed hit-area ring when nothing is in range.
- The ring is a DOM element, so hovering never redraws the canvases.
- Cursors: `crosshair` (Add), an SVG eraser cursor (Erase), `grab` (Pan tool or Space), `grabbing` while dragging, and `not-allowed` when the active group is hidden, locked or missing.

### Spatial index
Benchmarked on 10k random points in a 4000x3000 image (Node, `spatial-index.test.ts`):
- linear scan: ~45 µs per query;
- grid build: ~0.6 ms;
- grid query: ~0.9 µs.

Both are fast enough for one query per tap or hover move, so a linear scan would be acceptable. `createPointIndex` uses the linear scan below 2000 points and the grid above. The index is rebuilt lazily on the first query after an edit, so editing never pays the build cost unless a query follows.

### Wheel
- Read `deltaMode` before `deltaX`/`deltaY`. Firefox reports line units only if `deltaMode` is read first ([bug 1392460](https://bugzilla.mozilla.org/show_bug.cgi?id=1392460)). Lines are converted at 16 px and pages at the viewport size.
- No standard API distinguishes a mouse wheel from a trackpad, so classification is a heuristic (`classifyWheel`):
  - `ctrlKey`: pinch-zoom. Trackpad pinch arrives as ctrl+wheel in Chrome 31+, Firefox 55+ and Safari 15+ on macOS.
  - line/page mode: zoom.
  - any `deltaX`, legacy `wheelDeltaY === -3*deltaY`, or fractional `deltaY`: pan (trackpad).
  - otherwise: zoom.
  - The classification persists within a stream of wheel events less than 200 ms apart.
- The listener is non-passive and always calls `preventDefault()`, which also stops browser page zoom on ctrl+wheel.
- **Safari GestureEvent:** `gesturestart`/`gesturechange`/`gestureend` are prevented on the surface.
  - On macOS, `gesturechange.scale` drives zoom only when no touch pointers are down, and ctrl+wheel pinch events are ignored while a gesture is active, so input is never counted twice.
  - On iPad, pinch is handled by Pointer Events; gesture events are only prevented.

### Keyboard
- The container is focusable. Arrow keys pan (60 px, or 240 px with Shift), `+`/`=` zoom in, `-` zooms out, `0` fits. Keys with Cmd, Ctrl or Alt are left to the browser.
- Space-held panning is tracked on `window`. It is ignored when focus is in an editable field (text input, textarea, select, contenteditable). Space's default action is prevented only when the viewport itself has focus.
- The app shell owns tool shortcuts.

### Rendering cadence and memory
- One `requestAnimationFrame` per change, with separate dirty flags for the image and annotation layers.
- Annotation or style edits never redraw the image layer.
- A resize draws synchronously inside the ResizeObserver callback, so the canvas never shows blank.
- `onViewChange` fires at most once per frame.
- **Image pyramid.** Images with a long side over 2048 px get a halving mipmap built asynchronously. Each level is drawn from the previous one with high-quality smoothing, converted to an `ImageBitmap`, and its scratch canvas is released with `width = height = 0`. The smallest level with enough resolution for `scale x DPR` is drawn, using only the visible source rectangle, so a 24 MP photo at fit zoom reads from a ~1.5 MP bitmap. The pyramid adds about one third of the original's memory. Above 4 CSS px per image px, smoothing is turned off to show true pixels.
- **Backing-store cap.** Each layer is limited to 8 Mpx of device pixels and DPR to 3. iPad full screen (about 5.7 Mpx per layer at DPR 2) keeps native resolution; very large desktop windows get a reduced effective DPR. Canvases are released on unmount.
- **iOS canvas limits** (sources in §3, item 8):
  - Single canvas: 4096x4096 = 16.7 Mpx on older iOS; WebKit raised it to 8192x8192 in March 2024 (276145@main), probably shipping in Safari 18 (not verified).
  - Total canvas memory: older iOS capped it (`ramSize()/4`, "Total canvas memory use exceeds the maximum limit (384 MB)", `getContext` returning null). WebKit removed the cap in June 2023 (265628@main, likely Safari 17), so exceeding memory now risks the tab being killed.
  - Our worst case on iPad is two ~5.7 Mpx layers (about 45 MB) plus small sprites, the decoded original image (a 24 MP photo is about 96 MB, held by the app) and the pyramid (about 32 MB).

## 3. Platform facts and sources

1. **Pointer types.** The spec defines `mouse | pen | touch`; Pointer Events Level 3 is a W3C Recommendation ([spec](https://www.w3.org/TR/pointerevents3/)). Safari 13 (iOS/iPadOS 13) shipped Pointer Events ([WebKit blog](https://webkit.org/blog/9674/new-webkit-features-in-safari-13/), [MDN BCD](https://github.com/mdn/browser-compat-data/blob/main/api/PointerEvent.json)). WebKit maps an Apple Pencil (UIKit `Stylus`) to `"pen"` and fingers to `"touch"` ([PointerEventIOS.cpp](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/dom/ios/PointerEventIOS.cpp)).
2. **Touch contact size.** On iOS, `width`/`height` = 2 x UIKit `majorRadius`, a circular approximation ([NativeWebTouchEventIOS.mm](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/Shared/ios/NativeWebTouchEventIOS.mm), [UITouch.majorRadius](https://developer.apple.com/documentation/uikit/uitouch/majorradius)). It is a coarse palm signal at best. *Not verified:* whether resting palms reach web content at all, and the value quantisation.
3. **Apple Pencil hover** (iPad Pro M2 and later, Safari 16.1+). It arrives as pointer events with `pointerType "pen"` and `buttons === 0` ([WebKit blog 16.1](https://webkit.org/blog/13399/webkit-features-in-safari-16-1/), [WKMouseInteraction.mm](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/ios/WKMouseInteraction.mm)). The hover pointer and the contact pointer have different `pointerId`s ([OpenLayers #16225](https://github.com/openlayers/openlayers/issues/16225)). Our machine treats untracked pointers as hover, so this is handled.
4. **Palm rejection.** There is no web API, and the spec says UAs "may ignore the concurrent use of more than one type of pointer input" ([spec](https://w3c.github.io/pointerevents/)). An Apple forum report (FB16411500) says that on iPad Safari a Pencil that is down blocks touch pointer events, and vice versa ([forum](https://developer.apple.com/forums/thread/773213)); this is unconfirmed by Apple. The "Only Draw with Apple Pencil" setting (`UIPencilInteraction.prefersPencilOnlyDrawing`) is exposed to native apps only; we found no WebKit use of it (not verified).
5. **Scribble.** iPadOS Scribble can swallow Pencil events ([WebKit bug 217430](https://bugs.webkit.org/show_bug.cgi?id=217430), [forum](https://developer.apple.com/forums/thread/662874)). The workaround, which we apply on the surface only, is non-passive `touchstart`/`touchmove` listeners that call `preventDefault()`. This also suppresses iOS synthetic mouse and click events and double-tap zoom.
6. **Pointer capture and cancel.** Touch and pen get implicit capture. Capture is also set explicitly so mouse drags continue outside the viewport. `pointercancel` fires when the UA takes over panning or zooming, a dialog opens, the device disconnects or a hover device leaves range; it is followed by `pointerout`/`pointerleave` ([spec](https://www.w3.org/TR/pointerevents3/)). iPadOS system gestures also cancel.
7. **Coalesced and predicted events** arrived in Safari 18.2 ([WebKit blog 18.2](https://webkit.org/blog/16301/webkit-features-in-safari-18-2/)). **Not used:** panning needs only the latest position, and a point annotation needs only the contact-down position.
8. **touch-action.**
   - `none` disables all UA panning and zooming on the element ([MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/touch-action)).
   - Safari 13+ supports `auto`, `none`, `pan-x`, `pan-y`, `manipulation` and `pinch-zoom` ([BCD](https://github.com/mdn/browser-compat-data/blob/main/css/properties/touch-action.json)); `manipulation` disables double-tap zoom ([WebKit blog](https://webkit.org/blog/5610/more-responsive-tapping-on-ios/)).
   - Safari 10+ ignores `user-scalable=no` ([Safari 10 notes](https://developer.apple.com/library/archive/releasenotes/General/WhatsNewInSafari/Articles/Safari_10_0.html)), so page pinch is blocked per element, never globally.
   - We set `touch-action: none` on the surface canvas only; the rest of the app keeps normal scrolling and zoom.
   - *Not verified:* whether a pinch that starts with one finger outside the surface still zooms the page.
9. **GestureEvent** is non-standard. The documented version support conflicts ([Apple](https://developer.apple.com/documentation/webkitjs/gestureevent), [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Element/gesturestart_event)). Calling `preventDefault` to block page zoom in iOS Safari is common practice, but we found no primary Apple statement for it.
10. **Passive listeners.** `touchstart`, `touchmove`, `wheel` and `mousewheel` default to passive on window, document, documentElement and body ([DOM spec](https://dom.spec.whatwg.org/#default-passive-value)). We attach to the canvas with `{passive: false}`.
11. **Click synthesis.** Calling `preventDefault` on pointer events does not stop `click`, `auxclick` or `contextmenu`; cancelling `pointerdown` stops only compatibility mouse events ([spec](https://w3c.github.io/pointerevents/)). **We do not listen to `click` at all.** Annotation happens only on `pointerup` after the gesture machine decides it was a tap.
12. **Long press and selection.**
    - `-webkit-touch-callout: none` works on iOS only ([MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/-webkit-touch-callout)).
    - Safari still needs the prefixed `-webkit-user-select` (BCD).
    - iOS Safari does not fire `contextmenu` on long press ([WebKit bug 213953](https://bugs.webkit.org/show_bug.cgi?id=213953)); it is prevented on desktop.
    - On the viewport we also prevent `selectstart` and `dragstart` and set `-webkit-tap-highlight-color: transparent`.
13. **Canvas memory on iOS.**
    - [WebKit 276145@main](https://github.com/WebKit/WebKit/commit/d1f63c061eadee6c83dc9fa06a2725c3d099a86b) raised the maximum canvas area.
    - [WebKit 265628@main](https://github.com/WebKit/WebKit/commit/6bd11f3792f05b4e58e5647bf173212879fa62cc) and [bug 195325](https://bugs.webkit.org/show_bug.cgi?id=195325) removed the total canvas memory cap.
    - PQINA explains the [area limit](https://pqina.nl/blog/canvas-area-exceeds-the-maximum-limit/) and the [memory limit](https://pqina.nl/blog/total-canvas-memory-use-exceeds-the-maximum-limit/).
    - `createImageBitmap`, including the resize options, is supported from Safari 15 ([BCD](https://github.com/mdn/browser-compat-data/blob/main/api/_globals/createImageBitmap.json)).

## 4. What was tested

**Environment:**
- Google Chrome 154.0.8037.98, headless, on macOS 26.6.1, at DPR 2 and 1280x800.
- Input was driven over the Chrome DevTools Protocol (`Input.dispatchMouseEvent`, `Input.dispatchTouchEvent`, `Input.dispatchKeyEvent`). These events go through Chrome's real input pipeline (pointer events, capture, `touch-action`).
- The test page was the standalone demo at `/viewport-demo.html`, plus a spot check of the integrated app.
- The Claude-in-Chrome extension was not connected, so the tests ran headless.

**Passing checks:**
- Two layers with a 2x backing store; `role="img"` and `aria-label` on the surface; `touch-action: none` only on the surface.
- Click adds at the exact image coordinate. A near-duplicate is added and shows two in-place pulses.
- Drag pans by exactly the pointer delta and adds nothing. A 3 px jitter still counts as a click.
- Wheel zoom keeps the anchor fixed under the cursor (to 1e-2 image px). Ctrl+wheel zooms anchored. A two-axis wheel pans.
- Markers are drawn at the transformed position, verified by pixel colour.
- Erase hits the nearest marker within the mouse radius. Erase on empty space reports `nothing-to-erase`. Hidden, locked or missing groups report `hidden`, `locked` or `no-group` and add nothing; the cursor shows `not-allowed`.
- Right-click adds nothing. Middle-drag pans.
- Clicking focuses the viewport; then `+` zooms and `0` fits. Space+drag pans with the grab cursor. Space+click adds nothing.
- Touch:
  - a tap with `touchAnnotates=false` adds nothing;
  - a one-finger drag pans exactly;
  - a tap with `touchAnnotates=true` adds;
  - a two-finger spread pinches by exactly 2.0x and adds nothing;
  - a quick two-finger tap adds nothing.
- Resizing to 640x1100 (rotation) keeps the centre image point and scale exactly.
- The pulse stays in place (fixed bug) in the demo and in the integrated app at `http://localhost:5173`.
- Erase hover preview appears for a hovering mouse.

**Performance** (headless and therefore software-ish GPU, on a machine shared with other build agents; indicative only):
- 5000 markers at fit: annotation layer record median about 5 ms without labels, about 8–9 ms with labels on two groups.
- Forced readback of both 2040x1600 layers took 30 ms or more. This includes the synchronous GPU-to-CPU copy, so it is not an on-screen frame cost.
- In an earlier run, the rAF interval during continuous zooming with 5000 markers was 16.6 ms median and 17.3 ms p95, which is 60 fps.
- 15k markers zoomed in (about 2000 visible): record median 7.4 ms.

**Visual checks** (composited screenshots): 5000 markers on light agar and on a dark blood-agar plate, in red dots, blue labelled circles and yellow dots, were all legible.

**Harness note:** large PNG screenshots of dense frames (several MB of base64) stalled the CDP connection. JPEG captures of the composited canvases were used instead. This was a harness limitation, not page behaviour; the page stayed responsive throughout.

## 5. Not verified (needs hardware)

- Apple Pencil classification, tap reliability, contact jitter versus the 8 px threshold, and hover on M2+ iPad Pro.
- iPadOS palm rejection with Pencil plus resting hand, and whether palm contacts reach the page and with what `width`/`height`.
- Double-tap zoom, page pinch-zoom, long-press callout and text selection suppression in iPad Safari.
- Whether a pinch starting partly outside the surface zooms the page.
- Scribble interference, and whether the `touchstart`/`touchmove` `preventDefault` workaround is still needed.
- macOS Safari trackpad pinch (GestureEvent path, and no double counting with ctrl+wheel), and Firefox line-mode wheel.
- Memory use and smoothness with real 12–24 MP photos on an iPad, and orientation changes mid-gesture.

## 6. Manual iPad test checklist

Record the device model, iPadOS version, Safari version, Pencil generation, and whether "Only Draw with Apple Pencil" is on. Use `/viewport-demo.html` (enable "touch annotates" where noted) or the app.

1. **Pencil tap (Add):** 20 deliberate taps on colonies. Expect exactly 20 markers at the touched points and no duplicates from synthetic clicks.
2. **Pencil tap with slight movement:** Expect markers for small wiggles. A deliberate stroke over 8 px pans and adds nothing.
3. **Pencil hover** (M2+ iPad Pro): Hover in Add mode shows a dashed ring that follows the tip. In Erase mode, the red ring highlights the marker that would be erased.
4. **Pencil erase:** Tapping near a marker of the active group (within about 22 px) erases it. Markers of other groups are never erased. Tapping empty space shows "nothing to erase".
5. **Palm:** Rest your hand on the screen, then tap with the Pencil 20 times. Expect exactly 20 markers. Lift the palm without the Pencil: nothing is added.
6. **Palm first:** Place the palm, wait 1 s, then tap with the Pencil. Expect exactly one marker.
7. **Fingers with Pencil** (`touchAnnotates` off): One-finger drag pans. Two-finger pinch zooms around the midpoint. A one-finger tap adds nothing. Two-finger and three-finger taps add nothing.
8. **Touch annotate** (`touchAnnotates` on, Pencil unused for over 10 s):
   - a one-finger tap adds;
   - a finger held longer than 0.5 s adds nothing;
   - a tap followed quickly by a second finger becomes a pinch with no marker;
   - lifting the pinch fingers in either order adds nothing, and the remaining finger keeps panning.
9. **Pen-recent lockout:** After any Pencil use, a finger tap with `touchAnnotates` on only pans, for about 10 s.
10. **Page gestures:** Pinch, double-tap and long-press on the image do not zoom the page, select text or show a callout or magnifier. Outside the image (sidebar, toolbar), normal scrolling and pinch still work.
11. **Edges:** Drag from inside the viewport to outside and back: panning continues and no marker appears. Swipe up from the home indicator or open Control Center mid-gesture: `pointercancel` adds nothing, and the next tap works normally.
12. **Rotation:** Zoom into a colony, rotate the iPad. The same colony stays at the centre at the same zoom, and markers stay on their colonies. Fitted views refit.
13. **App switch:** Start a pinch, switch apps, then return. There are no stuck gestures and the next tap behaves normally.
14. **Performance:** On a 24 MP photo, add 5000 markers (demo button). Pan and pinch should feel smooth (note the fps), and the tab should not reload (memory).
15. **Hidden/locked:** Hide or lock the active group. Taps add or erase nothing and the app explains why.
