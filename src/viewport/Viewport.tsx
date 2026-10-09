// Placeholder until the viewport implementation lands (owned by the viewport agent).
import type { ViewportProps } from './api'

export function Viewport(props: ViewportProps) {
  return <div class="viewport-placeholder" aria-label={props.label}>Viewport placeholder</div>
}
