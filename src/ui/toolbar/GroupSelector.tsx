import { createSignal, For, Show } from 'solid-js'
import type { AnnotationGroup, ID } from '../../model/types'
import { ChevronDown, ChevronUp, EyeOff, Lock, Plus, Trash, Check, Pencil, Eraser } from '../icons'
import { Popover, InlineEdit, Button, createPopoverState } from '../primitives'
import { GroupSwatch } from '../shared/GroupSwatch'

/** Active annotation-group selector with inline group management (no side panel). */
export interface GroupSelectorProps {
  groups: readonly AnnotationGroup[]
  /** Confirmed count per group on the current image. */
  counts: ReadonlyMap<ID, number>
  activeId: ID | null
  /** Hide the name on the trigger (very narrow toolbars still show swatch + count). */
  dense?: boolean
  onSelect(id: ID): void
  /** Creates a group and returns its id (it becomes active). */
  onCreate(): ID | null
  onRename(id: ID, name: string): void
  onDelete(id: ID): void
  onMove(id: ID, delta: number): void
  /** "Clear annotations…": asks for the scope (this image / all images) first. */
  onClear(id: ID): void
}

export function GroupSelector(props: GroupSelectorProps) {
  const pop = createPopoverState()
  const [renaming, setRenaming] = createSignal(false)
  const active = () => props.groups.find((g) => g.id === props.activeId)
  const activeIndex = () => props.groups.findIndex((g) => g.id === props.activeId)
  const count = (id: ID) => props.counts.get(id) ?? 0

  return (
    <>
      <button
        ref={pop.setAnchor}
        type="button"
        class="group-trigger"
        classList={{ 'is-open': pop.open(), 'group-trigger--dense': props.dense }}
        aria-haspopup="dialog"
        aria-expanded={pop.open()}
        aria-label={
          active()
            ? `Annotation group: ${active()!.name}, ${count(active()!.id)} on this image${active()!.hidden ? ', hidden' : ''}${active()!.locked ? ', locked' : ''}. Change group`
            : 'Choose annotation group'
        }
        title="Annotation group (1–9)"
        onClick={() => {
          setRenaming(false)
          pop.toggle()
        }}
      >
        <Show when={active()} fallback={<span class="group-trigger__name">No group</span>}>
          {(g) => (
            <>
              <GroupSwatch color={g().color} render={g().render} muted={g().hidden} size={16} />
              <span class="group-trigger__name">{g().name}</span>
              <span class="group-trigger__count">{count(g().id).toLocaleString()}</span>
            </>
          )}
        </Show>
        <ChevronDown class="group-trigger__chevron" size={16} aria-hidden="true" />
      </button>

      <Popover open={pop.open()} anchor={pop.anchor()} onClose={pop.close} label="Annotation groups" width={320} class="group-pop">
        <div class="pop-header">
          <span class="pop-title">Annotation groups</span>
          <span class="pop-subtitle">Counts on this image</span>
        </div>
        <ul class="group-list" role="listbox" aria-label="Annotation groups" onKeyDown={(e) => listKeys(e)}>
          <For each={props.groups}>
            {(g, i) => (
              <li
                role="option"
                tabIndex={g.id === props.activeId ? 0 : -1}
                data-item
                data-autofocus={g.id === props.activeId ? '' : undefined}
                class="group-option"
                aria-selected={g.id === props.activeId}
                onClick={() => {
                  props.onSelect(g.id)
                  pop.close()
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    props.onSelect(g.id)
                    pop.close()
                  }
                }}
              >
                <span class="group-option__check" aria-hidden="true">
                  <Show when={g.id === props.activeId}>
                    <Check size={15} stroke-width={2.4} />
                  </Show>
                </span>
                <GroupSwatch color={g.color} render={g.render} muted={g.hidden} size={16} />
                <span class="group-option__name">{g.name}</span>
                <span class="group-option__flags">
                  <Show when={g.hidden}>
                    <span class="flag" title="Hidden">
                      <EyeOff size={14} aria-hidden="true" />
                      <span class="flag__text">Hidden</span>
                    </span>
                  </Show>
                  <Show when={g.locked}>
                    <span class="flag" title="Locked">
                      <Lock size={14} aria-hidden="true" />
                      <span class="flag__text">Locked</span>
                    </span>
                  </Show>
                </span>
                <span class="group-option__count" aria-label={`${count(g.id)} on this image`}>
                  {count(g.id).toLocaleString()}
                </span>
                <span class="group-option__key">
                  <Show when={i() < 9}>
                    <kbd aria-label={`Shortcut ${i() + 1}`}>{i() + 1}</kbd>
                  </Show>
                </span>
              </li>
            )}
          </For>
        </ul>
        <button
          type="button"
          class="pop-row-button"
          data-item
          onClick={() => {
            if (props.onCreate()) setRenaming(true)
          }}
        >
          <Plus size={17} aria-hidden="true" /> New group
        </button>

        <Show when={active()}>
          {(g) => (
            <div class="group-manage" classList={{ 'is-editing': renaming() }}>
              <div class="group-manage__label">Selected group</div>
              <div class="group-manage__name-row">
                <GroupSwatch color={g().color} render={g().render} size={16} />
                <InlineEdit
                  value={g().name}
                  label="Group name"
                  class="group-manage__name"
                  editing={renaming()}
                  onEditingChange={setRenaming}
                  onCommit={(name) => props.onRename(g().id, name)}
                />
              </div>
              <div class="group-manage__actions">
                <Show when={!renaming()}>
                  <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setRenaming(true)}>
                    Rename
                  </Button>
                </Show>
                <Button size="sm" variant="ghost" icon={ChevronUp} aria-label="Move group up" disabled={activeIndex() <= 0} onClick={() => props.onMove(g().id, -1)}>
                  Up
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={ChevronDown}
                  aria-label="Move group down"
                  disabled={activeIndex() >= props.groups.length - 1}
                  onClick={() => props.onMove(g().id, 1)}
                >
                  Down
                </Button>
                <span class="group-manage__spacer" />
                <Button
                  size="sm"
                  variant="ghost"
                  icon={Eraser}
                  onClick={() => {
                    pop.close()
                    props.onClear(g().id)
                  }}
                >
                  Clear…
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={Trash}
                  class="group-manage__delete"
                  disabled={g().locked || props.groups.length <= 1}
                  onClick={() => props.onDelete(g().id)}
                >
                  Delete
                </Button>
              </div>
              <Show when={g().locked || props.groups.length <= 1}>
                <p class="field__hint group-manage__hint">
                  {g().locked ? 'Unlock this group to delete it.' : 'A project needs at least one annotation group.'}
                </p>
              </Show>
            </div>
          )}
        </Show>
      </Popover>
    </>
  )
}

function listKeys(e: KeyboardEvent) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  const list = e.currentTarget as HTMLElement
  const items = [...list.querySelectorAll<HTMLElement>('[role="option"]')]
  const i = items.indexOf(document.activeElement as HTMLElement)
  const next = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]
  e.preventDefault()
  e.stopPropagation()
  next?.focus()
}
