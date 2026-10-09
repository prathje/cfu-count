import { createEffect, createSignal, For, Show, type JSX } from 'solid-js'
import type { ID, ImageRecord } from '../../model/types'
import { ChevronDown, ChevronUp, ChevronRight, ImagePlus, MoreHorizontal, Pencil, Trash } from '../icons'
import { InlineEdit, MenuItem, MenuSection, Popover, createPopoverState } from '../primitives'
import { IMAGE_DRAG_TYPE } from './ImageRow'

/** Collapsible section of the image list; also a drop target for dragged images. */
export interface ImageGroupSectionProps {
  /** null = the "Ungrouped" section (not renamable/deletable). */
  groupId: ID | null
  name: string
  images: readonly ImageRecord[]
  collapsed: boolean
  /** Name is being edited (controlled by the sidebar so a new group can open in rename mode). */
  renaming?: boolean
  onRenamingChange?(renaming: boolean): void
  canMoveUp?: boolean
  canMoveDown?: boolean
  onToggle(): void
  onDropImage(imageId: ID): void
  onRename?(name: string): void
  onDelete?(): void
  onMove?(delta: number): void
  onImportHere?(): void
  /** Renders one image row. */
  children: (image: ImageRecord) => JSX.Element
}

export function ImageGroupSection(props: ImageGroupSectionProps) {
  const menu = createPopoverState()
  const [over, setOver] = createSignal(false)
  const renaming = () => !!props.renaming
  const setRenaming = (on: boolean) => props.onRenamingChange?.(on)
  const listId = `imgs-${props.groupId ?? 'ungrouped'}`

  let section: HTMLElement | undefined
  // Bring a group that enters rename mode (e.g. just created) into view.
  createEffect(() => {
    if (renaming()) queueMicrotask(() => section?.scrollIntoView({ block: 'nearest' }))
  })

  const accepts = (e: DragEvent) => !!e.dataTransfer?.types.includes(IMAGE_DRAG_TYPE)

  return (
    <section
      ref={section}
      class="img-group"
      classList={{ 'is-drop-target': over(), 'is-ungrouped': props.groupId === null }}
      aria-label={props.name}
      onDragOver={(e) => {
        if (!accepts(e)) return
        e.preventDefault()
        e.dataTransfer!.dropEffect = 'move'
        setOver(true)
      }}
      onDragLeave={(e) => {
        if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setOver(false)
      }}
      onDrop={(e) => {
        setOver(false)
        const id = e.dataTransfer?.getData(IMAGE_DRAG_TYPE)
        if (!id) return
        e.preventDefault()
        props.onDropImage(id)
      }}
    >
      <div class="img-group__head">
        <button
          type="button"
          class="img-group__toggle"
          aria-expanded={!props.collapsed}
          aria-controls={listId}
          aria-label={`${props.collapsed ? 'Expand' : 'Collapse'} ${props.name}`}
          onClick={() => props.onToggle()}
        >
          <ChevronRight class="img-group__chevron" size={15} aria-hidden="true" />
        </button>
        <Show when={props.onRename && renaming()} fallback={
          <button type="button" class="img-group__name" onClick={() => props.onToggle()} onDblClick={() => props.onRename && setRenaming(true)}>
            {props.name}
          </button>
        }>
          <InlineEdit value={props.name} label="Image group name" editing={true} onEditingChange={setRenaming} onCommit={(n) => props.onRename?.(n)} class="img-group__edit" />
        </Show>
        <span class="img-group__count" aria-label={`${props.images.length} images`}>
          {props.images.length}
        </span>
        <Show when={props.groupId !== null}>
          <button
            ref={menu.setAnchor}
            type="button"
            class="row-menu-btn"
            aria-label={`Actions for image group ${props.name}`}
            aria-haspopup="menu"
            aria-expanded={menu.open()}
            onClick={menu.toggle}
          >
            <MoreHorizontal size={16} aria-hidden="true" />
          </button>
          <Popover open={menu.open()} anchor={menu.anchor()} onClose={menu.close} label={`Image group ${props.name}`} role="menu" width={232} placement="bottom-end">
            <MenuSection>
              <MenuItem icon={ImagePlus} label="Import images here" onClick={() => { menu.close(); props.onImportHere?.() }} />
              <MenuItem icon={Pencil} label="Rename" onClick={() => { menu.close(); setRenaming(true) }} />
              <MenuItem icon={ChevronUp} label="Move up" disabled={!props.canMoveUp} onClick={() => props.onMove?.(-1)} />
              <MenuItem icon={ChevronDown} label="Move down" disabled={!props.canMoveDown} onClick={() => props.onMove?.(1)} />
            </MenuSection>
            <MenuSection>
              <MenuItem
                icon={Trash}
                danger
                label="Delete group"
                description="Images move to Ungrouped"
                onClick={() => { menu.close(); props.onDelete?.() }}
              />
            </MenuSection>
          </Popover>
        </Show>
      </div>
      <Show when={!props.collapsed}>
        <ul class="img-list" id={listId}>
          <For each={props.images} fallback={<li class="img-list__empty">{props.groupId ? 'Drag images here' : 'No ungrouped images'}</li>}>
            {(img) => props.children(img)}
          </For>
        </ul>
      </Show>
    </section>
  )
}
