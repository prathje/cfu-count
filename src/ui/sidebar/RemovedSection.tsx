import { For, Show } from 'solid-js'
import type { ID, ImageRecord } from '../../model/types'
import { ChevronRight, Images, Undo } from '../icons'
import { IconButton } from '../primitives'
import { formatRelativeDate } from '../format'

/**
 * "Recently removed": images the user removed from the project (soft delete).
 * Nothing was erased, so each one can be restored. Collapsed by default.
 */
export interface RemovedSectionProps {
  images: readonly ImageRecord[]
  collapsed: boolean
  onToggle(): void
  thumbnail(imageId: ID): string | undefined
  requestThumbnail(imageId: ID): void
  annotationCount(imageId: ID): number
  onRestore(imageId: ID): void
}

export function RemovedSection(props: RemovedSectionProps) {
  const listId = 'removed-images'
  return (
    <section class="img-group img-group--removed" aria-label="Recently removed images">
      <div class="img-group__head">
        <button
          type="button"
          class="img-group__toggle"
          aria-expanded={!props.collapsed}
          aria-controls={listId}
          aria-label={`${props.collapsed ? 'Expand' : 'Collapse'} Recently removed`}
          onClick={() => props.onToggle()}
        >
          <ChevronRight class="img-group__chevron" size={15} aria-hidden="true" />
        </button>
        <button type="button" class="img-group__name" onClick={() => props.onToggle()}>
          Recently removed
        </button>
        <span class="img-group__count" aria-label={`${props.images.length} removed images`}>
          {props.images.length}
        </span>
      </div>
      <Show when={!props.collapsed}>
        <p class="img-group__note">Not counted or exported. Nothing was erased: restore an image to bring it back with its annotations.</p>
        <ul class="img-list" id={listId}>
          <For each={props.images}>
            {(img) => {
              props.requestThumbnail(img.id)
              return (
                <li class="image-row image-row--removed">
                  <div class="image-row__main">
                    <span class="thumb">
                      <Show when={props.thumbnail(img.id)} fallback={<Images size={16} aria-hidden="true" class="thumb__ph" />}>
                        {(url) => <img src={url()} alt="" draggable={false} />}
                      </Show>
                    </span>
                    <span class="image-row__text">
                      <span class="image-row__name">{img.name}</span>
                      <span class="image-row__meta">
                        Removed {formatRelativeDate(img.deletedAt!)} · {props.annotationCount(img.id).toLocaleString()} marks
                      </span>
                    </span>
                  </div>
                  <IconButton icon={Undo} label={`Restore ${img.name}`} size="sm" variant="subtle" onClick={() => props.onRestore(img.id)} />
                </li>
              )
            }}
          </For>
        </ul>
      </Show>
    </section>
  )
}
