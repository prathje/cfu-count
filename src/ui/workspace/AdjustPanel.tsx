import { For, Show } from 'solid-js'
import type { DisplayChannel, ImageDisplayAdjust } from '../../model/types'
import { DISPLAY_PRESETS, isDefaultDisplay, matchingPreset } from '../../model/display'
import { Eye, RefreshCw } from '../icons'
import { Button, SegmentedControl, Slider, Switch } from '../primitives'
import './adjust-panel.css'

/** Display-only image adjustments (brightness, contrast, midtones, colour, channel) with presets. */
export interface AdjustPanelProps {
  value: ImageDisplayAdjust
  /** Name of the current image's image group, or null when ungrouped. */
  imageGroupName: string | null
  /** Images in the project / in the current image group. */
  imageCount: number
  groupImageCount: number
  /** True while the original is shown (hold-to-compare). */
  comparing: boolean
  /** Key caps for hints. */
  compareKey: string
  onChange(next: ImageDisplayAdjust): void
  onReset(): void
  onApplyAll(): void
  onApplyGroup(): void
  onCompare(active: boolean): void
}

const CHANNELS: { value: DisplayChannel; label: string }[] = [
  { value: 'rgb', label: 'Colour' },
  { value: 'red', label: 'Red' },
  { value: 'green', label: 'Green' },
  { value: 'blue', label: 'Blue' },
  { value: 'luma', label: 'Grey' },
]

const signedPercent = (v: number) => (v === 0 ? '0 %' : `${v > 0 ? '+' : '−'}${Math.abs(v)} %`)
/** Midtones slider works on log2(gamma) so 0.5× and 2× sit symmetrically around 1. */
const GAMMA_STEPS = 100

export function AdjustPanel(props: AdjustPanelProps) {
  const set = (patch: Partial<ImageDisplayAdjust>) => props.onChange({ ...props.value, ...patch })
  const preset = () => matchingPreset(props.value)?.id
  const colour = () => props.value.channel === 'rgb'

  // Hold-to-compare: pointer press, or Space/Enter held on the focused button.
  const holdHandlers = {
    onPointerDown: (e: PointerEvent) => {
      ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
      props.onCompare(true)
    },
    onPointerUp: () => props.onCompare(false),
    onPointerCancel: () => props.onCompare(false),
    onLostPointerCapture: () => props.onCompare(false),
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key !== ' ' && e.key !== 'Enter') return
      e.preventDefault()
      if (!e.repeat) props.onCompare(true)
    },
    onKeyUp: (e: KeyboardEvent) => {
      if (e.key === ' ' || e.key === 'Enter') props.onCompare(false)
    },
    onBlur: () => props.onCompare(false),
    onContextMenu: (e: MouseEvent) => e.preventDefault(), // iPad long-press must not open a menu
  }

  return (
    <div class="adjust-panel">
      <div>
        <div class="pop-title">Image adjustments</div>
        <div class="pop-subtitle">Display only — the photo, markers and counts don’t change</div>
      </div>

      <div class="adjust-panel__presets" role="group" aria-label="Presets">
        <For each={DISPLAY_PRESETS}>
          {(p) => (
            <button
              type="button"
              class="adjust-chip"
              aria-pressed={preset() === p.id}
              title={p.description}
              onClick={() => props.onChange({ ...p.value })}
            >
              {p.label}
            </button>
          )}
        </For>
      </div>

      <div class="field-block">
        <span class="field__label">Channel</span>
        <SegmentedControl label="Channel" value={props.value.channel} options={CHANNELS} onChange={(channel) => set({ channel })} />
      </div>

      <Switch
        label="Auto contrast"
        description="Stretch the image’s darkest to brightest tones"
        checked={props.value.autoContrast}
        onChange={(autoContrast) => set({ autoContrast })}
      />

      <Slider
        label="Brightness"
        value={Math.round(props.value.brightness * 100)}
        min={-100}
        max={100}
        format={signedPercent}
        onInput={(v) => set({ brightness: v / 100 })}
      />
      <Slider
        label="Contrast"
        value={Math.round(props.value.contrast * 100)}
        min={-100}
        max={100}
        format={signedPercent}
        onInput={(v) => set({ contrast: v / 100 })}
      />
      <Slider
        label="Midtones (gamma)"
        value={Math.round(Math.log2(props.value.gamma) * GAMMA_STEPS)}
        min={Math.round(Math.log2(0.2) * GAMMA_STEPS)}
        max={Math.round(Math.log2(5) * GAMMA_STEPS)}
        format={(v) => {
          const g = Math.pow(2, v / GAMMA_STEPS)
          return `${g.toFixed(2)}${g > 1.005 ? ' · lighter' : g < 0.995 ? ' · darker' : ''}`
        }}
        onInput={(v) => set({ gamma: v === 0 ? 1 : Math.pow(2, v / GAMMA_STEPS) })}
      />
      <Slider
        label="Saturation"
        value={Math.round(props.value.saturation * 100)}
        min={0}
        max={300}
        step={5}
        disabled={!colour()}
        format={(v) => (colour() ? `${v} %` : 'Colour view only')}
        onInput={(v) => set({ saturation: v / 100 })}
      />
      <Switch label="Invert" description="Swap light and dark tones" checked={props.value.invert} onChange={(invert) => set({ invert })} />

      <div class="adjust-panel__row">
        <button
          type="button"
          class="btn btn--subtle btn--md btn--labelled adjust-panel__compare"
          classList={{ 'is-pressed': props.comparing }}
          aria-pressed={props.comparing}
          disabled={isDefaultDisplay(props.value)}
          title={`Hold to see the original (or hold ${props.compareKey})`}
          {...holdHandlers}
        >
          <Eye size={17} stroke-width={1.9} aria-hidden="true" />
          <span class="btn__label">Hold for original</span>
        </button>
        <Button icon={RefreshCw} disabled={isDefaultDisplay(props.value)} onClick={() => props.onReset()}>
          Reset
        </Button>
      </div>

      <div class="adjust-panel__apply">
        <span class="field__label">Use these settings for</span>
        <div class="adjust-panel__row">
          <Show when={props.imageGroupName !== null && props.groupImageCount > 1}>
            <Button size="sm" onClick={() => props.onApplyGroup()}>
              “{props.imageGroupName}” ({props.groupImageCount})
            </Button>
          </Show>
          <Button size="sm" disabled={props.imageCount < 2} onClick={() => props.onApplyAll()}>
            All {props.imageCount} images
          </Button>
        </div>
      </div>
    </div>
  )
}
