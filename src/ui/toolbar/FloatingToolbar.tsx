import { For, Show } from 'solid-js'
import type { AnnotationGroup, ID } from '../../model/types'
import type { GroupStylePatch } from '../../model/groups'
import { toolHintKey, type Tool } from '../../model/tool'
import {
  ChevronDown,
  Eraser,
  Eye,
  EyeOff,
  Hand,
  Lock,
  LockOpen,
  MoreHorizontal,
  Plus,
  Redo,
  SlidersHorizontal,
  Undo,
  type IconComponent,
} from '../icons'
import { Button, IconButton, MenuItem, Popover, ToggleButton, createPopoverState } from '../primitives'
import { GroupSelector } from './GroupSelector'
import { StylePanel } from './StylePanel'
import type { ToolbarMode } from './layout'

export { toolbarModeFor, type ToolbarMode } from './layout'

export const TOOLS: readonly { tool: Tool; label: string; icon: IconComponent; key: string }[] = [
  { tool: 'add', label: 'Add', icon: Plus, key: toolHintKey('add') },
  { tool: 'erase', label: 'Erase', icon: Eraser, key: toolHintKey('erase') },
  { tool: 'pan', label: 'Pan', icon: Hand, key: toolHintKey('pan') },
]

/** The single-row annotation toolbar floating over the image. Order is fixed by the approved layout. */
export interface FloatingToolbarProps {
  mode: ToolbarMode
  groups: readonly AnnotationGroup[]
  counts: ReadonlyMap<ID, number>
  activeGroup: AnnotationGroup | undefined
  tool: Tool
  canUndo: boolean
  canRedo: boolean
  /** Modifier label for shortcut hints ("⌘" or "Ctrl+"). */
  mod: string
  onSelectGroup(id: ID): void
  onCreateGroup(): ID | null
  onRenameGroup(id: ID, name: string): void
  onDeleteGroup(id: ID): void
  onMoveGroup(id: ID, delta: number): void
  onToggleHidden(): void
  onToggleLocked(): void
  onStyleChange(patch: GroupStylePatch): void
  onTool(tool: Tool): void
  onUndo(): void
  onRedo(): void
}

export function FloatingToolbar(props: FloatingToolbarProps) {
  const style = createPopoverState()
  const more = createPopoverState()
  const toolPop = createPopoverState()
  const labelled = () => props.mode === 'full'
  const g = () => props.activeGroup
  const activeTool = () => TOOLS.find((t) => t.tool === props.tool)!

  const stylePanel = () => (
    <Show when={g()} fallback={<p class="pop-empty">Select a group to change its appearance.</p>}>
      {(group) => (
        <StylePanel
          group={group()}
          onChange={props.onStyleChange}
          onUnlock={() => {
            if (group().locked) props.onToggleLocked()
          }}
        />
      )}
    </Show>
  )

  return (
    <div class="toolbar" role="toolbar" aria-label="Annotation tools" data-mode={props.mode}>
      {/* 1. Group selector */}
      <GroupSelector
        groups={props.groups}
        counts={props.counts}
        activeId={g()?.id ?? null}
        dense={props.mode === 'tiny'}
        onSelect={props.onSelectGroup}
        onCreate={props.onCreateGroup}
        onRename={props.onRenameGroup}
        onDelete={props.onDeleteGroup}
        onMove={props.onMoveGroup}
      />
      {/* 2. Visibility  3. Lock */}
      <ToggleButton
        icon={g()?.hidden ? EyeOff : Eye}
        label={g()?.hidden ? 'Group hidden — show' : 'Group visible — hide'}
        pressed={!!g()?.hidden}
        shortcut="V"
        class={`btn--state ${g()?.hidden ? 'is-warning' : ''}`}
        disabled={!g()}
        onClick={() => props.onToggleHidden()}
      />
      <ToggleButton
        icon={g()?.locked ? Lock : LockOpen}
        label={g()?.locked ? 'Group locked — unlock' : 'Group unlocked — lock'}
        pressed={!!g()?.locked}
        shortcut="L"
        class={`btn--state ${g()?.locked ? 'is-warning' : ''}`}
        disabled={!g()}
        onClick={() => props.onToggleLocked()}
      />
      {/* 4. Style */}
      <Show when={props.mode === 'full' || props.mode === 'compact'}>
        <IconButton
          ref={style.setAnchor}
          icon={SlidersHorizontal}
          label="Style"
          showLabel={labelled()}
          hint="Group appearance"
          aria-haspopup="dialog"
          aria-expanded={style.open()}
          class={style.open() ? 'is-open' : ''}
          disabled={!g()}
          onClick={style.toggle}
        />
        <Popover open={style.open()} anchor={style.anchor()} onClose={style.close} label="Group style" width={312}>
          {stylePanel()}
        </Popover>
      </Show>

      <span class="toolbar__sep" aria-hidden="true" />

      {/* 5–7. Tools */}
      <Show
        when={props.mode !== 'tiny'}
        fallback={
          <>
            <IconButton
              ref={toolPop.setAnchor}
              icon={activeTool().icon}
              label={`Tool: ${activeTool().label}. Change tool`}
              class="btn--tool-switch is-pressed"
              aria-haspopup="menu"
              aria-expanded={toolPop.open()}
              trailing={<ChevronDown size={14} aria-hidden="true" class="btn__chevron" />}
              onClick={toolPop.toggle}
            />
            <Popover open={toolPop.open()} anchor={toolPop.anchor()} onClose={toolPop.close} label="Tools" role="menu" width={220}>
              <For each={TOOLS}>
                {(t) => (
                  <MenuItem
                    role="menuitemradio"
                    aria-checked={props.tool === t.tool}
                    checked={props.tool === t.tool}
                    data-autofocus={props.tool === t.tool ? '' : undefined}
                    icon={t.icon}
                    label={t.label}
                    trailing={<kbd>{t.key}</kbd>}
                    onClick={() => {
                      props.onTool(t.tool)
                      toolPop.close()
                    }}
                  />
                )}
              </For>
            </Popover>
          </>
        }
      >
        <For each={TOOLS}>
          {(t) => (
            <ToggleButton
              icon={t.icon}
              label={t.label}
              showLabel={labelled()}
              shortcut={t.key}
              pressed={props.tool === t.tool}
              class="btn--tool"
              onClick={() => props.onTool(t.tool)}
            />
          )}
        </For>
      </Show>

      {/* 8–9. History (or More) */}
      <Show
        when={props.mode === 'full' || props.mode === 'compact'}
        fallback={
          <>
            <span class="toolbar__sep" aria-hidden="true" />
            <IconButton
              ref={more.setAnchor}
              icon={MoreHorizontal}
              label="More: style, undo, redo"
              aria-haspopup="dialog"
              aria-expanded={more.open()}
              class={more.open() ? 'is-open' : ''}
              onClick={more.toggle}
            />
            <Popover open={more.open()} anchor={more.anchor()} onClose={more.close} label="More tools" width={320} placement="bottom-end">
              <div class="more-history">
                <Button icon={Undo} disabled={!props.canUndo} onClick={() => props.onUndo()}>
                  Undo
                </Button>
                <Button icon={Redo} disabled={!props.canRedo} onClick={() => props.onRedo()}>
                  Redo
                </Button>
              </div>
              {stylePanel()}
            </Popover>
          </>
        }
      >
        <span class="toolbar__sep" aria-hidden="true" />
        <IconButton icon={Undo} label="Undo" shortcut={`${props.mod}Z`} disabled={!props.canUndo} onClick={() => props.onUndo()} />
        <IconButton icon={Redo} label="Redo" shortcut={`⇧${props.mod}Z`} disabled={!props.canRedo} onClick={() => props.onRedo()} />
      </Show>
    </div>
  )
}
