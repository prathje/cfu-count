import { For, Show } from 'solid-js'
import type { DriveState, ProjectSummary } from '../../storage/api'
import { Cloud, FileArchive, FolderOpen, ImagePlus, Loader, Microscope, Plus, Upload } from '../icons'
import { Button } from '../primitives'
import { formatRelativeDate, plural } from '../format'

/** Shown inside the workspace when the open project has no images yet. */
export interface NoImagesProps {
  dragging: boolean
  importing: number
  onImportFiles(): void
  /** Present only when Google Drive is connected. */
  onImportDrive?: () => void
}

export function NoImages(props: NoImagesProps) {
  return (
    <div class="empty empty--images">
      <button
        type="button"
        class="dropzone"
        classList={{ 'is-dragging': props.dragging }}
        onClick={() => props.onImportFiles()}
        aria-describedby="dropzone-help"
      >
        <span class="dropzone__icon">
          <Show when={props.importing > 0} fallback={<ImagePlus size={30} stroke-width={1.6} aria-hidden="true" />}>
            <Loader class="spin" size={30} aria-hidden="true" />
          </Show>
        </span>
        <span class="dropzone__title">
          {props.importing > 0 ? `Importing ${plural(props.importing, 'image')}…` : props.dragging ? 'Drop to import' : 'Add plate photos'}
        </span>
        <span class="dropzone__text" id="dropzone-help">
          Drag images here, or click to choose files. JPEG, PNG and WebP work everywhere; several files at once are fine.
        </span>
        <span class="dropzone__cta">
          <Upload size={16} aria-hidden="true" /> Choose images
        </span>
      </button>
      <Show when={props.onImportDrive}>
        {(fn) => (
          <Button icon={Cloud} variant="ghost" onClick={() => fn()()}>
            Import from Google Drive
          </Button>
        )}
      </Show>
      <p class="empty__fine">Images stay in your browser{props.onImportDrive ? ' and your Drive folder' : ''}. Nothing is uploaded to a server.</p>
    </div>
  )
}

/** Full-page start screen when no project is open. */
export interface NoProjectProps {
  projects: readonly ProjectSummary[]
  drive: DriveState
  onCreate(): void
  onImportArchive(): void
  onOpen(id: string): void
  onOpenDrive(): void
  onConnectDrive(): void
}

export function NoProject(props: NoProjectProps) {
  return (
    <div class="empty empty--start">
      <div class="start-card">
        <div class="start-card__mark" aria-hidden="true">
          <Microscope size={28} stroke-width={1.6} />
        </div>
        <h1 class="start-card__title">Count colonies, plate by plate</h1>
        <p class="start-card__text">
          A project holds your plate photos, organised into image groups you name yourself. Everything runs in this browser.
        </p>
        <div class="start-card__actions">
          <Button variant="primary" size="lg" icon={Plus} onClick={() => props.onCreate()}>
            New project
          </Button>
          <Button size="lg" icon={FileArchive} onClick={() => props.onImportArchive()}>
            Import project (.zip)
          </Button>
          <Show
            when={props.drive.state === 'connected'}
            fallback={
              <Show when={props.drive.state !== 'unconfigured'}>
                <Button size="lg" variant="ghost" icon={Cloud} onClick={() => props.onConnectDrive()}>
                  Connect Google Drive
                </Button>
              </Show>
            }
          >
            <Button size="lg" variant="ghost" icon={FolderOpen} onClick={() => props.onOpenDrive()}>
              Open from Google Drive
            </Button>
          </Show>
        </div>
        <Show when={props.projects.length > 0}>
          <div class="start-card__recent">
            <div class="section-label">Projects in this browser</div>
            <ul class="recent-list">
              <For each={props.projects}>
                {(p) => (
                  <li>
                    <button type="button" class="recent-item" onClick={() => props.onOpen(p.id)}>
                      <span class="recent-item__name">{p.name}</span>
                      <span class="recent-item__meta">
                        {plural(p.imageCount, 'image')} · {formatRelativeDate(p.updatedAt)}
                        {p.storage === 'drive' ? ` · Drive: ${p.driveFolderName ?? 'linked'}` : ''}
                      </span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </div>
        </Show>
      </div>
    </div>
  )
}

/** Initial loading screen. */
export function LoadingScreen(props: { label: string }) {
  return (
    <div class="empty empty--loading" role="status">
      <Loader class="spin" size={22} aria-hidden="true" />
      <span>{props.label}</span>
    </div>
  )
}
