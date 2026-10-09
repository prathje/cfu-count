import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import type { ID, ImageGroup, ImageRecord } from '../../model/types'
import { AlertTriangle, Check, Images, MoreHorizontal, Pencil, Trash, ArrowRightLeft } from '../icons'
import { MenuItem, MenuSection, Popover, createPopoverState } from '../primitives'

export const IMAGE_DRAG_TYPE = 'application/x-cfu-image'

/** One image in the sidebar: thumbnail, name, confirmed count and a menu for moving/renaming/removing. */
export interface ImageRowProps {
  image: ImageRecord
  selected: boolean
  count: number
  thumbnail: string | undefined
  imageGroups: readonly ImageGroup[]
  onVisible(): void
  onSelect(): void
  onAssign(groupId: ID | null): void
  onRename(): void
  onRemove(): void
}

export function ImageRow(props: ImageRowProps) {
  const menu = createPopoverState()
  const [dragging, setDragging] = createSignal(false)
  let el: HTMLLIElement | undefined

  onMount(() => {
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          props.onVisible()
          io.disconnect()
        }
      },
      { rootMargin: '200px' },
    )
    if (el) io.observe(el)
    onCleanup(() => io.disconnect())
  })

  return (
    <li
      ref={el}
      class="image-row"
      classList={{ 'is-selected': props.selected, 'is-dragging': dragging() }}
      draggable={true}
      onDragStart={(e) => {
        e.dataTransfer?.setData(IMAGE_DRAG_TYPE, props.image.id)
        e.dataTransfer!.effectAllowed = 'move'
        setDragging(true)
      }}
      onDragEnd={() => setDragging(false)}
    >
      <button
        type="button"
        class="image-row__main"
        aria-current={props.selected ? 'true' : undefined}
        aria-label={`${props.image.name}, ${props.count} confirmed`}
        onClick={() => props.onSelect()}
      >
        <span class="thumb">
          <Show when={props.thumbnail} fallback={<Images size={16} aria-hidden="true" class="thumb__ph" />}>
            <img src={props.thumbnail} alt="" draggable={false} />
          </Show>
        </span>
        <span class="image-row__text">
          <span class="image-row__name">{props.image.name}</span>
          <span class="image-row__meta">
            <Show when={props.image.sourceMismatch}>
              <AlertTriangle size={12} class="text-warn" aria-label="Image changed" />
            </Show>
            {props.image.width} × {props.image.height}
          </span>
        </span>
        <span class="image-row__count" classList={{ 'is-zero': props.count === 0 }}>
          {props.count.toLocaleString()}
        </span>
      </button>
      <button
        ref={menu.setAnchor}
        type="button"
        class="row-menu-btn"
        aria-label={`Actions for ${props.image.name}`}
        aria-haspopup="menu"
        aria-expanded={menu.open()}
        onClick={menu.toggle}
      >
        <MoreHorizontal size={16} aria-hidden="true" />
      </button>
      <Popover open={menu.open()} anchor={menu.anchor()} onClose={menu.close} label={`Actions for ${props.image.name}`} role="menu" width={248} placement="bottom-end">
        <MenuSection title="Move to image group">
          <For each={[...props.imageGroups, { id: null as ID | null, name: 'Ungrouped' }]}>
            {(g) => (
              <MenuItem
                role="menuitemradio"
                aria-checked={props.image.imageGroupId === g.id}
                icon={props.image.imageGroupId === g.id ? Check : ArrowRightLeft}
                checked={props.image.imageGroupId === g.id}
                label={g.name}
                onClick={() => {
                  props.onAssign(g.id)
                  menu.close()
                }}
              />
            )}
          </For>
        </MenuSection>
        <MenuSection>
          <MenuItem
            icon={Pencil}
            label="Rename image"
            onClick={() => {
              menu.close()
              props.onRename()
            }}
          />
          <MenuItem
            icon={Trash}
            label="Remove from project"
            danger
            onClick={() => {
              menu.close()
              props.onRemove()
            }}
          />
        </MenuSection>
      </Popover>
    </li>
  )
}
