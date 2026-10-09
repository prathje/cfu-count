import { For, Show } from 'solid-js'
import type { ProjectSummary } from '../../storage/api'
import { Check, ChevronDown, Cloud, Download, FileArchive, FileSpreadsheet, FolderOpen, Keyboard, Plus, Trash } from '../icons'
import { InlineEdit, MenuItem, MenuSection, Popover, createPopoverState } from '../primitives'
import { formatRelativeDate, plural } from '../format'

/** Project switcher + project-level actions (rename, new, import/export, delete). */
export interface ProjectMenuProps {
  /** Current project name, or null when none is open. */
  projectName: string | null
  projectId: string | null
  projects: readonly ProjectSummary[]
  driveConnected: boolean
  compact: boolean
  onRename(name: string): void
  onOpen(id: string): void
  onCreate(): void
  onImportArchive(): void
  onDownloadArchive(): void
  onExportCsv(): void
  onOpenFromDrive(): void
  onDelete(): void
  onShowShortcuts(): void
}

export function ProjectMenu(props: ProjectMenuProps) {
  const pop = createPopoverState()
  const others = () =>
    [...props.projects].filter((p) => p.id !== props.projectId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const act = (fn: () => void) => () => {
    pop.close()
    fn()
  }

  return (
    <>
      <button
        ref={pop.setAnchor}
        type="button"
        class="project-trigger"
        classList={{ 'is-open': pop.open() }}
        aria-haspopup="dialog"
        aria-expanded={pop.open()}
        aria-label={props.projectName ? `Project: ${props.projectName}. Project menu` : 'Projects'}
        onClick={pop.toggle}
      >
        <span class="project-trigger__label">{props.projectName ?? 'Projects'}</span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      <Popover open={pop.open()} anchor={pop.anchor()} onClose={pop.close} label="Project menu" width={320} class="project-pop">
        <Show when={props.projectName}>
          {(name) => (
            <div class="pop-header">
              <span class="section-label">Current project</span>
              <InlineEdit value={name()} label="Project name" class="project-pop__name" onCommit={props.onRename} />
            </div>
          )}
        </Show>
        <Show when={others().length > 0}>
          <MenuSection title="Switch project">
            <div class="project-pop__list" data-roving>
              <For each={others()}>
                {(p) => (
                  <MenuItem
                    label={p.name}
                    description={`${plural(p.imageCount, 'image')} · ${formatRelativeDate(p.updatedAt)}${p.storage === 'drive' ? ' · on Drive' : ''}`}
                    icon={p.storage === 'drive' ? Cloud : undefined}
                    onClick={act(() => props.onOpen(p.id))}
                  />
                )}
              </For>
            </div>
          </MenuSection>
        </Show>
        <MenuSection>
          <MenuItem icon={Plus} label="New project" onClick={act(props.onCreate)} />
          <MenuItem icon={FileArchive} label="Import project (.zip)" onClick={act(props.onImportArchive)} />
          <Show when={props.driveConnected}>
            <MenuItem icon={FolderOpen} label="Open project from Drive" onClick={act(props.onOpenFromDrive)} />
          </Show>
        </MenuSection>
        <Show when={props.projectId}>
          <MenuSection title="Export">
            <MenuItem icon={Download} label="Download project (.zip)" description="Images, annotations and summary" onClick={act(props.onDownloadArchive)} />
            <MenuItem icon={FileSpreadsheet} label="Export CSV summary" description="One row per image and annotation group" onClick={act(props.onExportCsv)} />
          </MenuSection>
          <MenuSection>
            <MenuItem icon={Trash} danger label="Delete project from this browser" onClick={act(props.onDelete)} />
          </MenuSection>
        </Show>
        <MenuSection>
          <MenuItem icon={Keyboard} label="Keyboard shortcuts" trailing={<kbd>?</kbd>} onClick={act(props.onShowShortcuts)} />
        </MenuSection>
        <Show when={!props.projectId && others().length === 0}>
          <p class="pop-empty">
            <Check size={14} aria-hidden="true" /> No projects yet.
          </p>
        </Show>
      </Popover>
    </>
  )
}
