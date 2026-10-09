/**
 * Display size of markers. A group's `size` is a SCREEN-space radius in CSS px:
 * markers keep that size while you zoom in, so dense plates stay readable.
 *
 * Exception, far zoomed out: when one screen px covers more than two image px
 * (view scale < FULL_SIZE_SCALE) colonies are physically tiny on screen and
 * full-size markers would swamp the plate. The radius then shrinks smoothly with
 * the square root of the scale, never below MIN_DISPLAY_RADIUS (and never above
 * the user's size). It is continuous at FULL_SIZE_SCALE, so zooming never makes
 * markers jump. Hit testing, hover rings and the duplicate cue use the same radius,
 * so what you see is what you can tap.
 */

/** View scale (screen CSS px per image px) at and above which markers use the group size unchanged. */
export const FULL_SIZE_SCALE = 0.5
/** Smallest displayed radius (CSS px) when zoomed far out. */
export const MIN_DISPLAY_RADIUS = 3.5

/** Displayed marker radius (CSS px) for a group size at a view scale, quantised to 0.5 px (sprite cache friendly). */
export function displayRadius(size: number, scale: number): number {
  if (!(scale < FULL_SIZE_SCALE) || size <= MIN_DISPLAY_RADIUS) return size
  const r = size * Math.sqrt(Math.max(0, scale) / FULL_SIZE_SCALE)
  return Math.max(MIN_DISPLAY_RADIUS, Math.round(r * 2) / 2)
}
