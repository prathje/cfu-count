import { createUniqueId } from 'solid-js'

/** Labelled range input with a visible, formatted value (e.g. "80 %", "6 px on screen"). */
export interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  /** Formats the visible value and aria-valuetext. */
  format(value: number): string
  onInput(value: number): void
  disabled?: boolean
}

export function Slider(props: SliderProps) {
  const id = createUniqueId()
  const fill = () => ((props.value - props.min) / (props.max - props.min)) * 100
  return (
    <div class="slider" classList={{ 'is-disabled': props.disabled }}>
      <div class="slider__head">
        <label for={id}>{props.label}</label>
        <output for={id} class="slider__value">
          {props.format(props.value)}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        disabled={props.disabled}
        aria-valuetext={props.format(props.value)}
        style={{ '--fill': `${fill()}%` }}
        onInput={(e) => props.onInput(Number(e.currentTarget.value))}
      />
    </div>
  )
}
