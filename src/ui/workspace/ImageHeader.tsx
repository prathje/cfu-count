import { createEffect, createSignal, For, on, onCleanup, Show } from 'solid-js'
import type { SourceMismatch } from '../../model/types'
import { AlertTriangle, ChevronDown, ChevronUp, EyeOff, Lock } from '../icons'
import { IconButton } from '../primitives'
import { GroupSwatch } from '../shared/GroupSwatch'
import { plural } from '../format'

/** Per-group line in the header breakdown. */
export interface GroupTally {
  id: string
  name: string
  color: string
  render: 'dot' | 'circle'
  count: number
  hidden: boolean
  locked: boolean
}

/** Current image name, image-group context and the large confirmed total (with a polite live region). */
export interface ImageHeaderProps {
  imageName: string
  imageGroupName: string | null
  width: number
  height: number
  total: number
  tallies: readonly GroupTally[]
  mismatch?: SourceMismatch
  /** 1-based position in the project's display order. */
  position: number
  of: number
  onPrevious(): void
  onNext(): void
}

export function ImageHeader(props: ImageHeaderProps) {
  // Announce count changes politely, debounced so rapid taps produce one announcement.
  const [announcement, setAnnouncement] = createSignal('')
  let timer: ReturnType<typeof setTimeout> | undefined
  createEffect(
    on(
      () => [props.total, props.imageName] as const,
      ([total, name], prev) => {
        if (!prev) return
        clearTimeout(timer)
        const text = prev[1] !== name ? `${name}: ${plural(total, 'confirmed colony', 'confirmed colonies')}` : `${plural(total, 'confirmed colony', 'confirmed colonies')}`
        timer = setTimeout(() => setAnnouncement(text), 600)
      },
    ),
  )
  onCleanup(() => clearTimeout(timer))

  return (
    <header class="image-header">
      <div class="image-header__nav">
        <IconButton icon={ChevronUp} label="Previous image" size="sm" disabled={props.position <= 1} onClick={() => props.onPrevious()} />
        <IconButton icon={ChevronDown} label="Next image" size="sm" disabled={props.position >= props.of} onClick={() => props.onNext()} />
      </div>
      <div class="image-header__title">
        <div class="image-header__context">
          <span>{props.imageGroupName ?? 'Ungrouped'}</span>
          <span aria-hidden="true">·</span>
          <span>
            Image {props.position} of {props.of}
          </span>
          <span aria-hidden="true" class="hide-narrow">·</span>
          <span class="hide-narrow">
            {props.width.toLocaleString()} × {props.height.toLocaleString()} px
          </span>
        </div>
        <h1 class="image-header__name" title={props.imageName}>
          {props.imageName}
        </h1>
      </div>
      <Show when={props.tallies.length > 1}>
        <ul class="tallies" aria-label="Confirmed colonies per annotation group">
          <For each={props.tallies}>
            {(t) => (
              <li class="tally" classList={{ 'is-hidden': t.hidden }}>
                <GroupSwatch color={t.color} render={t.render} size={10} muted={t.hidden} />
                <span class="tally__name">{t.name}</span>
                <Show when={t.hidden}>
                  <EyeOff size={12} aria-label="hidden" />
                </Show>
                <Show when={t.locked}>
                  <Lock size={12} aria-label="locked" />
                </Show>
                <span class="tally__count">{t.count.toLocaleString()}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <div class="image-total" aria-label={`${plural(props.total, 'confirmed colony', 'confirmed colonies')} on this image`}>
        <span class="image-total__value">{props.total.toLocaleString()}</span>
        <span class="image-total__label">{props.total === 1 ? 'colony' : 'colonies'}</span>
      </div>
      <div class="sr-only" aria-live="polite" aria-atomic="true">
        {announcement()}
      </div>
      <Show when={props.mismatch}>
        {(m) => (
          <div class="image-header__warning" role="alert">
            <AlertTriangle size={16} aria-hidden="true" />
            <span>
              <strong>Image changed since it was annotated.</strong> {m().message}
            </span>
          </div>
        )}
      </Show>
    </header>
  )
}
