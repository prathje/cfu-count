import { createEffect, For, Match, Show, Switch } from 'solid-js'
import HistoryIcon from 'lucide-solid/icons/rotate-ccw-clock'
import RotateCcw from 'lucide-solid/icons/rotate-ccw'
import Save from 'lucide-solid/icons/save'
import type { ID, Project } from '../../model/types'
import type { VersionInfo } from '../../storage/api'
import { ChevronLeft, HardDrive, Loader, Trash, X } from '../icons'
import { Button } from '../primitives'
import { plural } from '../format'
import { deltaText, groupByDay, groupRows, reasonTag, versionDateTime, versionTime, type CurrentCounts, type ImageRow } from './versionView'
import './version-history.css'

/** Version history: versions grouped by day, a preview of the selected one and restore actions. */
export interface VersionHistoryDialogProps {
  open: boolean
  /** Phone layout: bottom sheet, list and detail as two steps. */
  phone: boolean
  versions: readonly VersionInfo[] | null
  project: Project | null
  now: CurrentCounts
  selectedId: ID | null
  /** Per-image comparison of the selected version (null while loading or on failure). */
  imageRows: readonly ImageRow[] | null
  previewLoading: boolean
  driveLinked: boolean
  busy: boolean
  onSelect(id: ID | null): void
  onSaveNow(): void
  onRestore(version: VersionInfo): void
  onRestoreImage(version: VersionInfo, imageId: ID): void
  onDelete(version: VersionInfo): void
  onClose(): void
}

export function VersionHistoryDialog(props: VersionHistoryDialogProps) {
  let dialog: HTMLDialogElement | undefined
  let list: HTMLDivElement | undefined
  createEffect(() => {
    if (!dialog) return
    if (props.open && !dialog.open) {
      dialog.showModal()
      queueMicrotask(() => list?.querySelector<HTMLElement>('.vh-item[aria-current="true"], .vh-item')?.focus({ preventScroll: true }))
    } else if (!props.open && dialog.open) dialog.close()
  })

  const selected = () => props.versions?.find((v) => v.id === props.selectedId) ?? null
  const days = () => groupByDay(props.versions ?? [])
  const showDetail = () => !props.phone || !!selected()
  const showList = () => !props.phone || !selected()

  /** Arrow keys move through versions (and select them on wide screens). */
  function onListKey(e: KeyboardEvent) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
    const items = [...(list?.querySelectorAll<HTMLButtonElement>('.vh-item') ?? [])]
    if (!items.length) return
    e.preventDefault()
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))
    items[next].focus()
    if (!props.phone) items[next].click()
  }

  return (
    <dialog
      ref={dialog}
      class="dialog vh"
      classList={{ 'vh--sheet': props.phone }}
      aria-labelledby="vh-title"
      aria-describedby="vh-where"
      onCancel={(e) => {
        e.preventDefault()
        if (props.phone && selected()) props.onSelect(null)
        else props.onClose()
      }}
      onClick={(e) => e.target === dialog && props.onClose()}
    >
      <header class="vh__head">
        <Show when={props.phone && selected()} fallback={<HistoryIcon size={18} aria-hidden="true" />}>
          <button type="button" class="vh__icon-btn" aria-label="Back to all versions" onClick={() => props.onSelect(null)}>
            <ChevronLeft size={20} aria-hidden="true" />
          </button>
        </Show>
        <div class="vh__titles">
          <h2 id="vh-title" class="dialog__title">
            Version history
          </h2>
          <p id="vh-where" class="vh__where">
            <HardDrive size={13} aria-hidden="true" /> Versions are stored in this browser
          </p>
        </div>
        <button type="button" class="vh__icon-btn" aria-label="Close" onClick={() => props.onClose()}>
          <X size={18} aria-hidden="true" />
        </button>
      </header>

      <div class="vh__body">
        <Show when={showList()}>
          <div class="vh__list" ref={list} onKeyDown={onListKey}>
            <div class="vh__list-top">
              <Button icon={Save} size="sm" onClick={() => props.onSaveNow()} disabled={props.busy}>
                Save version now
              </Button>
            </div>
            <Switch>
              <Match when={props.versions === null}>
                <p class="vh__empty">
                  <Loader class="spin" size={15} aria-hidden="true" /> Loading versions…
                </p>
              </Match>
              <Match when={props.versions?.length === 0}>
                <p class="vh__empty">
                  No versions yet. A version is saved automatically when you start editing, every 10 minutes while you work, and before you clear or
                  delete annotations.
                </p>
              </Match>
              <Match when={true}>
                <For each={days()}>
                  {(day) => (
                    <section class="vh-day" aria-label={day.title}>
                      <h3 class="section-label vh-day__title">{day.title}</h3>
                      <ul class="vh-day__list">
                        <For each={day.versions}>
                          {(v) => {
                            const tag = reasonTag(v.reason)
                            return (
                              <li>
                                <button
                                  type="button"
                                  class="vh-item"
                                  aria-current={v.id === props.selectedId ? 'true' : undefined}
                                  onClick={() => props.onSelect(v.id)}
                                >
                                  <span class="vh-item__time">{versionTime(v)}</span>
                                  <span class="vh-item__main">
                                    <span class="vh-item__label">{v.label}</span>
                                    <span class="vh-item__meta">
                                      <span class={`vh-tag vh-tag--${tag.tone}`}>{tag.text}</span>
                                      {plural(v.counts.annotations, 'annotation')} · {deltaText(v.counts.annotations, props.now.annotations)}
                                      <Show when={v.counts.images !== props.now.images}> · {plural(v.counts.images, 'image')}</Show>
                                    </span>
                                  </span>
                                </button>
                              </li>
                            )
                          }}
                        </For>
                      </ul>
                    </section>
                  )}
                </For>
              </Match>
            </Switch>
          </div>
        </Show>

        <Show when={showDetail()}>
          <div class="vh__detail" aria-live="polite">
            <Show
              when={selected()}
              fallback={
                <p class="vh__empty vh__empty--detail">
                  <Show when={props.versions?.length} fallback="Versions you save appear here.">
                    Select a version to compare it with the project now.
                  </Show>
                </p>
              }
            >
              {(v) => (
                <VersionDetail
                  version={v()}
                  project={props.project}
                  now={props.now}
                  rows={props.imageRows}
                  loading={props.previewLoading}
                  busy={props.busy}
                  onRestore={() => props.onRestore(v())}
                  onRestoreImage={(id) => props.onRestoreImage(v(), id)}
                  onDelete={() => props.onDelete(v())}
                />
              )}
            </Show>
          </div>
        </Show>
      </div>

      <footer class="vh__foot">
        Versions include annotations, groups and image settings — not image files, which are never deleted. They stay in this browser only (not in
        Drive or .zip downloads); clearing site data removes them.
        <Show when={props.driveLinked}> Google Drive also keeps its own file revisions of this project.</Show>
      </footer>
    </dialog>
  )
}

function VersionDetail(props: {
  version: VersionInfo
  project: Project | null
  now: CurrentCounts
  rows: readonly ImageRow[] | null
  loading: boolean
  busy: boolean
  onRestore(): void
  onRestoreImage(imageId: ID): void
  onDelete(): void
}) {
  const groups = () => (props.project ? groupRows(props.version, props.project, props.now) : [])
  const changed = () => props.rows?.filter((r) => r.changed || r.addedLater) ?? []
  const unchanged = () => (props.rows?.length ?? 0) - changed().length
  const active = (id: ID) => !!props.project?.images.some((i) => i.id === id && !i.deletedAt)
  const tag = () => reasonTag(props.version.reason)

  return (
    <div class="vh-detail">
      <div class="vh-detail__head">
        <span class={`vh-tag vh-tag--${tag().tone}`}>{tag().text}</span>
        <h3 class="vh-detail__title">{versionDateTime(props.version)}</h3>
        <p class="vh-detail__label">{props.version.label}</p>
      </div>

      <div class="vh-stats">
        <div class="vh-stat">
          <span class="vh-stat__value">{props.version.counts.annotations.toLocaleString()}</span>
          <span class="vh-stat__label">annotations</span>
          <span class="vh-stat__delta">Now {props.now.annotations.toLocaleString()}</span>
        </div>
        <div class="vh-stat">
          <span class="vh-stat__value">{props.version.counts.images.toLocaleString()}</span>
          <span class="vh-stat__label">{props.version.counts.images === 1 ? 'image' : 'images'}</span>
          <span class="vh-stat__delta">Now {props.now.images.toLocaleString()}</span>
        </div>
      </div>

      <table class="vh-table">
        <caption class="sr-only">Confirmed annotations per group: this version and now</caption>
        <thead>
          <tr>
            <th scope="col">Group</th>
            <th scope="col">Version</th>
            <th scope="col">Now</th>
          </tr>
        </thead>
        <tbody>
          <For each={groups()}>
            {(g) => (
              <tr classList={{ 'is-diff': g.version !== g.now }}>
                <th scope="row">
                  <span class="vh-dot" style={{ background: g.color }} aria-hidden="true" />
                  {g.name}
                  <Show when={g.status !== 'both'}>
                    <span class="vh-table__note">{g.status === 'version-only' ? ' (deleted since)' : ' (new since)'}</span>
                  </Show>
                </th>
                <td>{g.version.toLocaleString()}</td>
                <td>{g.now.toLocaleString()}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>

      <section class="vh-images" aria-label="Images that differ">
        <h4 class="section-label">Images that differ</h4>
        <Switch>
          <Match when={props.loading}>
            <p class="vh__empty">
              <Loader class="spin" size={15} aria-hidden="true" /> Comparing…
            </p>
          </Match>
          <Match when={props.rows && changed().length === 0}>
            <p class="vh__empty">Every image matches this version.</p>
          </Match>
          <Match when={props.rows}>
            <ul class="vh-images__list">
              <For each={changed()}>
                {(r) => (
                  <li class="vh-image">
                    <span class="vh-image__name" title={r.name}>
                      {r.name}
                    </span>
                    <span class="vh-image__counts">
                      <Show when={!r.addedLater} fallback="Added later">
                        {r.version.toLocaleString()} → now {r.now.toLocaleString()}
                      </Show>
                    </span>
                    <Show when={!r.addedLater && active(r.id)}>
                      <button type="button" class="vh-image__restore" onClick={() => props.onRestoreImage(r.id)} disabled={props.busy}>
                        Restore only this image
                      </button>
                    </Show>
                    <Show when={!r.addedLater && !active(r.id)}>
                      <span class="vh-image__note">Removed now</span>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
            <Show when={unchanged() > 0}>
              <p class="vh-images__more">{plural(unchanged(), 'other image')} unchanged.</p>
            </Show>
          </Match>
        </Switch>
      </section>

      <div class="vh-detail__actions">
        <button type="button" class="vh-delete" onClick={() => props.onDelete()} disabled={props.busy}>
          <Trash size={14} aria-hidden="true" /> Delete version
        </button>
        <Button variant="primary" icon={RotateCcw} onClick={() => props.onRestore()} disabled={props.busy}>
          Restore this version
        </Button>
      </div>
    </div>
  )
}
