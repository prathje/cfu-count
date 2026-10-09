import { createSignal, For, Show } from 'solid-js'
import type { ID, Project } from '../../model/types'
import { imagesInGroup } from '../../state/core'
import { Cloud, FolderPlus, Loader, Upload } from '../icons'
import { Button, IconButton, InlineEdit } from '../primitives'
import { plural } from '../format'
import { ImageGroupSection } from './ImageGroupSection'
import { ImageRow } from './ImageRow'

/** Left sidebar: project name, image groups with images, import actions. */
export interface SidebarProps {
  project: Project
  currentImageId: ID | null
  importing: number
  driveConnected: boolean
  imageCount(imageId: ID): number
  thumbnail(imageId: ID): string | undefined
  requestThumbnail(imageId: ID): void
  onSelectImage(imageId: ID): void
  onImportFiles(imageGroupId: ID | null): void
  onImportDrive(imageGroupId: ID | null): void
  onRenameProject(name: string): void
  onCreateImageGroup(): void
  onRenameImageGroup(id: ID, name: string): void
  onDeleteImageGroup(id: ID): void
  onMoveImageGroup(id: ID, delta: number): void
  onAssignImage(imageId: ID, imageGroupId: ID | null): void
  onRenameImage(imageId: ID): void
  onRemoveImage(imageId: ID): void
}

export function Sidebar(props: SidebarProps) {
  const [collapsed, setCollapsed] = createSignal<Record<string, boolean>>({})
  const isCollapsed = (key: string) => !!collapsed()[key]
  const toggle = (key: string) => setCollapsed((c) => ({ ...c, [key]: !c[key] }))
  const ungrouped = () => imagesInGroup(props.project, null)

  const row = (img: Project['images'][number]) => (
    <ImageRow
      image={img}
      selected={img.id === props.currentImageId}
      count={props.imageCount(img.id)}
      thumbnail={props.thumbnail(img.id)}
      imageGroups={props.project.imageGroups}
      onVisible={() => props.requestThumbnail(img.id)}
      onSelect={() => props.onSelectImage(img.id)}
      onAssign={(gid) => props.onAssignImage(img.id, gid)}
      onRename={() => props.onRenameImage(img.id)}
      onRemove={() => props.onRemoveImage(img.id)}
    />
  )

  return (
    <nav class="sidebar" aria-label="Project images">
      <div class="sidebar__head">
        <div class="section-label">Project</div>
        <InlineEdit value={props.project.name} label="Project name" class="sidebar__project" onCommit={props.onRenameProject} />
        <div class="sidebar__meta">
          {plural(props.project.images.length, 'image')}
          <Show when={props.project.imageGroups.length}>
            {' · '}
            {plural(props.project.imageGroups.length, 'group')}
          </Show>
        </div>
        <div class="sidebar__actions">
          <Button variant="primary" icon={props.importing ? Loader : Upload} class={props.importing ? 'is-busy' : ''} onClick={() => props.onImportFiles(null)}>
            {props.importing ? `Importing ${props.importing}…` : 'Import images'}
          </Button>
          <Show when={props.driveConnected}>
            <IconButton icon={Cloud} label="Import from Google Drive" variant="subtle" onClick={() => props.onImportDrive(null)} />
          </Show>
          <IconButton icon={FolderPlus} label="New image group" variant="subtle" onClick={() => props.onCreateImageGroup()} />
        </div>
      </div>

      <div class="sidebar__scroll">
        <For each={props.project.imageGroups}>
          {(g, i) => (
            <ImageGroupSection
              groupId={g.id}
              name={g.name}
              images={imagesInGroup(props.project, g.id)}
              collapsed={isCollapsed(g.id)}
              canMoveUp={i() > 0}
              canMoveDown={i() < props.project.imageGroups.length - 1}
              onToggle={() => toggle(g.id)}
              onDropImage={(id) => props.onAssignImage(id, g.id)}
              onRename={(name) => props.onRenameImageGroup(g.id, name)}
              onDelete={() => props.onDeleteImageGroup(g.id)}
              onMove={(d) => props.onMoveImageGroup(g.id, d)}
              onImportHere={() => props.onImportFiles(g.id)}
            >
              {row}
            </ImageGroupSection>
          )}
        </For>
        <Show when={ungrouped().length > 0 || props.project.imageGroups.length > 0}>
          <ImageGroupSection
            groupId={null}
            name="Ungrouped"
            images={ungrouped()}
            collapsed={isCollapsed('__ungrouped')}
            onToggle={() => toggle('__ungrouped')}
            onDropImage={(id) => props.onAssignImage(id, null)}
          >
            {row}
          </ImageGroupSection>
        </Show>
        <Show when={props.project.images.length === 0}>
          <p class="sidebar__empty">No images yet. Import plate photos to start counting.</p>
        </Show>
      </div>
      <div class="sidebar__foot">Drop image files anywhere to import · drag rows between groups</div>
    </nav>
  )
}
