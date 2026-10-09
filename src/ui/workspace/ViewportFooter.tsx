import { Show } from 'solid-js'
import { Contrast, Maximize, Pointer, ZoomIn, ZoomOut } from '../icons'
import { IconButton, ToggleButton } from '../primitives'
import '../shared/float-bar.css'

/** Zoom controls and a compact visible/hidden count or interaction hint along the viewport's lower edge. */
export interface ViewportFooterProps {
  /** Screen px per image px, or null before the image is shown. */
  scale: number | null
  visible: number
  hidden: number
  /** Interaction hint (shown when there is room). */
  hint: string
  /** Show the touch-to-annotate toggle (coarse-pointer devices). */
  showTouchToggle: boolean
  touchAnnotates: boolean
  /** Compact layout for narrow viewports. */
  compact: boolean
  onZoomIn(): void
  onZoomOut(): void
  onFit(): void
  /** Zoom to 100 % (1 image px = 1 screen px). */
  onActualSize(): void
  onTouchAnnotates(on: boolean): void
  /** Display adjustments are set for this image (shows an indicator). */
  adjustActive: boolean
  /** The adjustments popover is open. */
  adjustOpen: boolean
  /** The original is being shown (hold-to-compare). */
  comparing: boolean
  onToggleAdjust(): void
  /** Anchor element for the adjustments popover. */
  adjustRef(el: HTMLButtonElement): void
}

export function ViewportFooter(props: ViewportFooterProps) {
  const percent = () => (props.scale == null ? '—' : `${Math.round(props.scale * 100)}%`)
  return (
    <div class="vp-footer">
      <div class="vp-footer__left">
      <div class="float-bar vp-zoom" role="group" aria-label="Zoom">
        <IconButton icon={ZoomOut} label="Zoom out" shortcut="−" onClick={() => props.onZoomOut()} disabled={props.scale == null} />
        <button
          type="button"
          class="vp-zoom__level"
          title="Zoom to 100 % (actual pixels)"
          aria-label={`Zoom ${percent()}. Set to 100 percent`}
          disabled={props.scale == null}
          onClick={() => props.onActualSize()}
        >
          {percent()}
        </button>
        <IconButton icon={ZoomIn} label="Zoom in" shortcut="+" onClick={() => props.onZoomIn()} disabled={props.scale == null} />
        <IconButton icon={Maximize} label="Fit" showLabel={!props.compact} shortcut="0" onClick={() => props.onFit()} disabled={props.scale == null} />
      </div>
      <ToggleButton
        ref={(el) => props.adjustRef(el)}
        icon={Contrast}
        label={props.comparing ? 'Original' : props.compact ? `Image adjustments${props.adjustActive ? ' (on)' : ''}` : 'Adjust'}
        showLabel={!props.compact}
        shortcut="I"
        hint={props.adjustActive ? 'Display adjustments are on for this image (display only)' : 'Brightness, contrast, channels (display only)'}
        pressed={props.adjustOpen}
        aria-haspopup="dialog"
        aria-expanded={props.adjustOpen}
        class="float-bar vp-adjust"
        classList={{ 'is-active': props.adjustActive, 'is-comparing': props.comparing }}
        onClick={() => props.onToggleAdjust()}
        trailing={
          props.adjustActive ? (
            <>
              <span class="vp-adjust__dot" aria-hidden="true" />
              <span class="sr-only">(on)</span>
            </>
          ) : undefined
        }
      />
      </div>

      <div class="vp-footer__right">
        <Show when={props.showTouchToggle}>
          <ToggleButton
            icon={Pointer}
            label={props.touchAnnotates ? 'Touch annotates: on' : 'Touch annotates: off'}
            showLabel={!props.compact}
            hint={props.touchAnnotates ? 'One-finger taps add or erase markers' : 'Fingers only pan and zoom; use Apple Pencil or turn this on to annotate by touch'}
            pressed={props.touchAnnotates}
            class="float-bar vp-touch"
            onClick={() => props.onTouchAnnotates(!props.touchAnnotates)}
          />
        </Show>
        <div class="float-bar vp-status" role="status" aria-live="off">
          <span class="vp-status__counts">
            <strong>{props.visible.toLocaleString()}</strong> visible
            <Show when={props.hidden > 0}>
              <span class="vp-status__dot" aria-hidden="true">·</span>
              <strong>{props.hidden.toLocaleString()}</strong> hidden
            </Show>
          </span>
          <Show when={!props.compact && props.hint}>
            <span class="vp-status__hint">{props.hint}</span>
          </Show>
        </div>
      </div>
    </div>
  )
}
