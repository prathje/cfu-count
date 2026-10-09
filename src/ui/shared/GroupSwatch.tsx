import type { MarkerRender } from '../../model/types'
import './GroupSwatch.css'

/** Colour chip that previews a group's marker style (filled dot vs circle outline). */
export interface GroupSwatchProps {
  color: string
  render: MarkerRender
  /** Diameter in CSS px. */
  size?: number
  /** Dim the swatch (e.g. hidden group); state must also be conveyed by text/icon elsewhere. */
  muted?: boolean
}

export function GroupSwatch(props: GroupSwatchProps) {
  return (
    <span
      class="swatch"
      classList={{ 'swatch--circle': props.render === 'circle', 'is-muted': props.muted }}
      style={{ '--swatch': props.color, '--swatch-size': `${props.size ?? 14}px` }}
      aria-hidden="true"
    />
  )
}
