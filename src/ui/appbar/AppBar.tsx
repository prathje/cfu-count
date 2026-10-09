import { Show, type JSX } from 'solid-js'
import { Microscope, PanelLeft } from '../icons'
import { ToggleButton } from '../primitives'

/** Top application bar layout: brand, sidebar toggle, project slot, status + Drive slots. */
export interface AppBarProps {
  showSidebarToggle: boolean
  sidebarOpen: boolean
  onToggleSidebar(): void
  /** Hide the product name text (narrow screens). */
  compact: boolean
  isDemo: boolean
  project: JSX.Element
  status: JSX.Element
  drive: JSX.Element
}

export function AppBar(props: AppBarProps) {
  return (
    <header class="appbar">
      <Show when={props.showSidebarToggle}>
        <ToggleButton
          icon={PanelLeft}
          label={props.sidebarOpen ? 'Hide images' : 'Show images'}
          pressed={props.sidebarOpen}
          aria-controls="sidebar"
          onClick={() => props.onToggleSidebar()}
        />
      </Show>
      <div class="brand" aria-label="CFU Count">
        <span class="brand__mark" aria-hidden="true">
          <Microscope size={17} stroke-width={2} />
        </span>
        <Show when={!props.compact}>
          <span class="brand__name">CFU Count</span>
        </Show>
      </div>
      <span class="appbar__divider" aria-hidden="true" />
      <div class="appbar__project">{props.project}</div>
      <Show when={props.isDemo}>
        <span class="demo-badge" title="The real storage layer isn’t available in this build, so nothing is saved when you reload.">
          Demo storage · not persisted
        </span>
      </Show>
      <div class="appbar__spacer" />
      <div class="appbar__right">
        {props.status}
        {props.drive}
      </div>
    </header>
  )
}
