/**
 * The single image <-> screen transform used by rendering, hit testing and input.
 *
 * Screen coordinates are CSS pixels relative to the viewport's top-left corner.
 * Image coordinates are original-image pixels (see src/model/types.ts).
 *
 *   screen = (image - offset) * scale
 *   image  = screen / scale + offset
 *
 * Device pixel ratio is NOT part of this transform: the canvas backing store is
 * scaled separately, so stored coordinates never depend on DPR, zoom or resize.
 * All functions are pure.
 */
import type { ViewState } from './api'

/** Width/height in CSS px (viewport) or image px (image). */
export interface Size {
  width: number
  height: number
}

/** A 2D point; the coordinate space is given by the function using it. */
export interface Point {
  x: number
  y: number
}

/** Allowed zoom range in screen CSS px per image px. */
export interface ScaleLimits {
  min: number
  max: number
}

/** Viewport edges (CSS px) covered by overlaid UI; fit avoids them. */
export interface Insets {
  top: number
  right: number
  bottom: number
  left: number
}

export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 }

/** Padding (CSS px) around the image when fitting. */
export const FIT_PADDING = 24
/** Highest zoom: screen CSS px per image px. */
export const MAX_SCALE = 32
/** How far below "fit" the user may zoom out, as a fraction of the fit scale. */
export const MIN_SCALE_OF_FIT = 0.5
/** Zoom step used by the zoom in/out buttons and +/- keys. */
export const ZOOM_STEP = 1.5

export function imageToScreen(view: ViewState, x: number, y: number): Point {
  return { x: (x - view.offsetX) * view.scale, y: (y - view.offsetY) * view.scale }
}

export function screenToImage(view: ViewState, sx: number, sy: number): Point {
  return { x: sx / view.scale + view.offsetX, y: sy / view.scale + view.offsetY }
}

/** The part of the viewport not covered by insets (never smaller than 1x1 px). */
export function availableRect(viewport: Size, insets: Insets = NO_INSETS) {
  const left = Math.max(0, Math.min(insets.left, viewport.width - 1))
  const top = Math.max(0, Math.min(insets.top, viewport.height - 1))
  const width = Math.max(1, viewport.width - left - Math.max(0, insets.right))
  const height = Math.max(1, viewport.height - top - Math.max(0, insets.bottom))
  return { x: left, y: top, width, height }
}

/** Scale at which the whole image fits the uncovered area with padding ("contain"). */
export function fitScale(image: Size, viewport: Size, padding = FIT_PADDING, insets: Insets = NO_INSETS): number {
  if (image.width <= 0 || image.height <= 0) return 1
  const area = availableRect(viewport, insets)
  const pad = Math.min(padding, area.width / 4, area.height / 4)
  const w = Math.max(1, area.width - 2 * pad)
  const h = Math.max(1, area.height - 2 * pad)
  return Math.min(w / image.width, h / image.height)
}

export function scaleLimits(image: Size, viewport: Size, insets: Insets = NO_INSETS): ScaleLimits {
  const fit = fitScale(image, viewport, FIT_PADDING, insets)
  const min = Math.min(fit * MIN_SCALE_OF_FIT, MAX_SCALE)
  return { min, max: Math.max(MAX_SCALE, fit) }
}

export function clampScale(scale: number, limits: ScaleLimits): number {
  if (!Number.isFinite(scale)) return limits.min
  return Math.min(limits.max, Math.max(limits.min, scale))
}

/** View that shows the image point (cx, cy) at the viewport centre. */
export function centeredOn(cx: number, cy: number, scale: number, viewport: Size): ViewState {
  return {
    scale,
    offsetX: cx - viewport.width / 2 / scale,
    offsetY: cy - viewport.height / 2 / scale,
  }
}

/** Image point currently at the viewport centre. */
export function viewCenter(view: ViewState, viewport: Size): Point {
  return screenToImage(view, viewport.width / 2, viewport.height / 2)
}

/** Fit the image, centred in the area not covered by insets. */
export function fitView(image: Size, viewport: Size, padding = FIT_PADDING, insets: Insets = NO_INSETS): ViewState {
  const scale = fitScale(image, viewport, padding, insets)
  const area = availableRect(viewport, insets)
  const cx = area.x + area.width / 2
  const cy = area.y + area.height / 2
  return { scale, offsetX: image.width / 2 - cx / scale, offsetY: image.height / 2 - cy / scale }
}

/**
 * Keep the image reachable: the viewport centre must stay inside the image
 * bounds, so the image can never be panned completely out of view.
 */
export function constrainView(view: ViewState, image: Size, viewport: Size): ViewState {
  const c = viewCenter(view, viewport)
  const cx = Math.min(image.width, Math.max(0, c.x))
  const cy = Math.min(image.height, Math.max(0, c.y))
  if (cx === c.x && cy === c.y) return view
  return centeredOn(cx, cy, view.scale, viewport)
}

/**
 * Zoom by `factor` keeping the image point under screen point (sx, sy) fixed.
 * The resulting scale is clamped; the anchor stays fixed for the clamped scale.
 */
export function zoomAt(
  view: ViewState,
  sx: number,
  sy: number,
  factor: number,
  limits: ScaleLimits,
): ViewState {
  const scale = clampScale(view.scale * factor, limits)
  const anchor = screenToImage(view, sx, sy)
  return { scale, offsetX: anchor.x - sx / scale, offsetY: anchor.y - sy / scale }
}

/** Set an absolute scale keeping the image point under (sx, sy) fixed. */
export function zoomToAt(
  view: ViewState,
  sx: number,
  sy: number,
  scale: number,
  limits: ScaleLimits,
): ViewState {
  return zoomAt(view, sx, sy, scale / view.scale, limits)
}

/** Move the content by (dx, dy) screen px (dragging right moves the image right). */
export function panBy(view: ViewState, dx: number, dy: number): ViewState {
  return { scale: view.scale, offsetX: view.offsetX - dx / view.scale, offsetY: view.offsetY - dy / view.scale }
}

/**
 * Viewport resized (window resize, orientation change, sidebar toggle): keep
 * the image point that was at the centre at the centre, same scale.
 */
export function resizeView(view: ViewState, oldViewport: Size, newViewport: Size): ViewState {
  const c = viewCenter(view, oldViewport)
  return centeredOn(c.x, c.y, view.scale, newViewport)
}

/** Visible image rectangle (may extend beyond the image bounds). */
export function visibleImageRect(view: ViewState, viewport: Size) {
  return {
    x: view.offsetX,
    y: view.offsetY,
    width: viewport.width / view.scale,
    height: viewport.height / view.scale,
  }
}

export function viewsEqual(a: ViewState, b: ViewState): boolean {
  return a.scale === b.scale && a.offsetX === b.offsetX && a.offsetY === b.offsetY
}

// ---------------------------------------------------------------------------
// Wheel handling
// ---------------------------------------------------------------------------

export const LINE_HEIGHT_PX = 16

/** Convert a WheelEvent delta to CSS pixels (deltaMode 0 = px, 1 = lines, 2 = pages). */
export function wheelDeltaToPixels(delta: number, deltaMode: number, pageSize: number): number {
  if (deltaMode === 1) return delta * LINE_HEIGHT_PX
  if (deltaMode === 2) return delta * pageSize
  return delta
}

/** The WheelEvent fields classifyWheel() needs (deltaMode must be read first, see Viewport). */
export interface WheelSample {
  deltaX: number
  deltaY: number
  deltaMode: number
  ctrlKey: boolean
  /** Legacy non-standard WheelEvent.wheelDeltaY (Chrome/Safari/Firefox); undefined if absent. */
  wheelDeltaY?: number
}

/** How a wheel event should be interpreted. */
export type WheelIntent = 'pinch' | 'zoom' | 'pan'

/**
 * Classify a wheel event. There is no standard way to tell a mouse wheel from a
 * trackpad two-finger scroll, so this is a documented heuristic:
 *  - ctrlKey: trackpad pinch (Chrome/Firefox/Edge synthesise ctrl+wheel) or a
 *    deliberate ctrl+wheel; zoom without letting the browser page-zoom.
 *  - deltaMode lines/pages: a notched mouse wheel (Firefox) -> zoom.
 *  - any horizontal component: trackpad (or tilt wheel) -> pan.
 *  - legacy wheelDeltaY === -3 * deltaY: trackpad on macOS Chrome/Safari -> pan.
 *  - otherwise: mouse wheel -> zoom.
 * `previous` lets a continuing scroll stream keep its classification so a
 * trackpad scroll does not flip to zoom on a frame with deltaX === 0.
 */
export function classifyWheel(e: WheelSample, previous: WheelIntent | null = null): WheelIntent {
  if (e.ctrlKey) return 'pinch'
  if (e.deltaMode !== 0) return 'zoom'
  if (previous === 'pan') return 'pan'
  if (e.deltaX !== 0) return 'pan'
  if (e.wheelDeltaY !== undefined && e.deltaY !== 0 && Math.abs(e.wheelDeltaY + 3 * e.deltaY) < 1e-6) {
    return 'pan'
  }
  if (previous === 'zoom') return 'zoom'
  // Fractional pixel deltas come from trackpads / smooth-scrolling devices.
  if (!Number.isInteger(e.deltaY)) return 'pan'
  return 'zoom'
}

/** Zoom factor for a wheel delta in CSS px. Pinch deltas are small, so they get more gain. */
export function wheelZoomFactor(deltaPx: number, intent: 'pinch' | 'zoom'): number {
  const gain = intent === 'pinch' ? 0.01 : 0.0015
  const d = Math.max(-300, Math.min(300, deltaPx))
  return Math.exp(-d * gain)
}
