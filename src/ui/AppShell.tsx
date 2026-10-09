import { createEffect, createSignal, Match, on, onCleanup, Show, Switch } from 'solid-js'
import type { ID } from '../model/types'
import { AppBar } from './appbar/AppBar'
import { DriveButton, SaveStatusPill, type DriveActions } from './appbar/DriveControls'
import { ProjectMenu } from './appbar/ProjectMenu'
import { useApp } from './context'
import { downloadBlob, IMAGE_ACCEPT, pickFiles, safeFilename } from './download'
import { ImagePlus, Loader } from './icons'
import { createMediaQuery, isApple } from './media'
import { DialogHost, ToastRegion, type createDialogs } from './primitives'
import { useShortcuts } from './shortcuts'
import { Sidebar } from './sidebar/Sidebar'
import { LoadingScreen, NoProject } from './workspace/EmptyStates'
import { WorkspaceContainer } from './workspace/WorkspaceContainer'
import './app.css'

/** Top-level container: layout, drawer, global drop/shortcuts, and wiring of app-bar + sidebar to the editor. */
export function AppShell(props: { dialogHost: ReturnType<typeof createDialogs> }) {
  const { editor, toaster, dialogs, thumbnails, isDemo } = useApp()
  const { state } = editor
  const narrow = createMediaQuery('(max-width: 900px)')
  const phone = createMediaQuery('(max-width: 560px)')
  const [sidebarOpen, setSidebarOpen] = createSignal(!narrow())
  const [dragging, setDragging] = createSignal(false)

  // Drawer: closed by default on narrow screens, open on wide ones.
  createEffect(on(narrow, (n) => setSidebarOpen(!n), { defer: true }))
  // Selecting an image on a narrow screen closes the drawer.
  createEffect(on(() => state.currentImageId, () => narrow() && setSidebarOpen(false), { defer: true }))
  // Project switch: drop cached thumbnails.
  createEffect(on(() => state.project?.id, () => thumbnails.clear(), { defer: true }))

  // -------------------------------------------------- persistence lifecycle
  const flushNow = () => void editor.flush()
  const onVisibility = () => document.visibilityState === 'hidden' && flushNow()
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', flushNow)
  onCleanup(() => {
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pagehide', flushNow)
  })

  // -------------------------------------------------- shortcuts
  useShortcuts(
    isApple,
    (cmd) => {
      switch (cmd.type) {
        case 'tool':
          return editor.setTool(cmd.tool)
        case 'toggle-visibility':
          return state.activeGroupId && editor.toggleHidden(state.activeGroupId)
        case 'toggle-lock':
          return state.activeGroupId && editor.toggleLocked(state.activeGroupId)
        case 'select-group':
          return editor.selectGroupByIndex(cmd.index)
        case 'undo':
          return editor.undo()
        case 'redo':
          return editor.redo()
      }
    },
    () => state.phase === 'ready',
  )

  // -------------------------------------------------- import / export
  async function ensureProject(): Promise<boolean> {
    if (state.project) return true
    return !!(await editor.createProject(defaultProjectName()))
  }

  async function importFiles(files: File[], imageGroupId: ID | null = null) {
    const zips = files.filter((f) => f.name.toLowerCase().endsWith('.zip'))
    const images = files.filter((f) => !zips.includes(f))
    for (const zip of zips) await editor.importArchive(zip)
    if (images.length && (await ensureProject())) await editor.importImages(images, imageGroupId)
  }

  async function chooseImages(imageGroupId: ID | null = null) {
    const files = await pickFiles({ accept: IMAGE_ACCEPT, multiple: true })
    if (files.length) await importFiles(files, imageGroupId)
  }

  async function chooseArchive() {
    const [file] = await pickFiles({ accept: '.zip,application/zip' })
    if (file) await editor.importArchive(file)
  }

  async function downloadArchive() {
    const blob = await editor.exportArchive()
    if (blob && state.project) downloadBlob(blob, `${safeFilename(state.project.name)}.zip`)
  }

  async function exportCsv() {
    const blob = await editor.exportCsv()
    if (blob && state.project) downloadBlob(blob, `${safeFilename(state.project.name)} summary.csv`)
  }

  async function newProject() {
    const name = await dialogs.prompt({
      title: 'New project',
      label: 'Project name',
      value: defaultProjectName(),
      confirmLabel: 'Create project',
      body: 'You can add image groups (e.g. treatments, batches, dilutions) after importing images.',
    })
    if (name) await editor.createProject(name)
  }

  async function deleteProject() {
    const p = state.project
    if (!p) return
    const linked = p.storage.kind === 'drive'
    const ok = await dialogs.confirm({
      title: `Delete “${p.name}” from this browser?`,
      body: linked
        ? 'The browser copy, its images and annotations are removed. The Google Drive folder is not touched.'
        : 'Its images and annotations are removed from this browser. Download a .zip first if you want a copy. This can’t be undone.',
      confirmLabel: 'Delete project',
      danger: true,
    })
    if (ok) await editor.deleteProject(p.id)
  }

  async function renameImage(imageId: ID) {
    const img = state.project?.images.find((i) => i.id === imageId)
    if (!img) return
    const name = await dialogs.prompt({ title: 'Rename image', label: 'Image name', value: img.name, confirmLabel: 'Rename' })
    if (name) editor.renameImage(imageId, name)
  }

  async function removeImage(imageId: ID) {
    const img = state.project?.images.find((i) => i.id === imageId)
    if (!img) return
    const n = editor.imageCount(imageId)
    const ok = await dialogs.confirm({
      title: `Remove “${img.name}”?`,
      body: n
        ? `Its ${n.toLocaleString()} ${n === 1 ? 'annotation' : 'annotations'} are removed too. This can’t be undone.`
        : 'The image is removed from this project.',
      confirmLabel: 'Remove image',
      danger: true,
    })
    if (ok) {
      thumbnails.forget(imageId)
      await editor.removeImage(imageId)
    }
  }

  async function deleteImageGroup(id: ID) {
    const g = state.project?.imageGroups.find((x) => x.id === id)
    if (!g) return
    const ok = await dialogs.confirm({
      title: `Delete image group “${g.name}”?`,
      body: 'Its images are kept and move to Ungrouped. Annotations are not affected.',
      confirmLabel: 'Delete group',
    })
    if (ok) editor.deleteImageGroup(id)
  }

  // -------------------------------------------------- global drag & drop of files
  let dragDepth = 0
  const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files')
  const onDragEnter = (e: DragEvent) => {
    if (!hasFiles(e)) return
    dragDepth++
    setDragging(true)
  }
  const onDragOver = (e: DragEvent) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.dataTransfer!.dropEffect = 'copy'
  }
  const onDragLeave = (e: DragEvent) => {
    if (!hasFiles(e)) return
    dragDepth = Math.max(0, dragDepth - 1)
    if (dragDepth === 0) setDragging(false)
  }
  const onDrop = (e: DragEvent) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    dragDepth = 0
    setDragging(false)
    const files = [...(e.dataTransfer?.files ?? [])]
    if (files.length) void importFiles(files)
  }
  window.addEventListener('dragenter', onDragEnter)
  window.addEventListener('dragover', onDragOver)
  window.addEventListener('dragleave', onDragLeave)
  window.addEventListener('drop', onDrop)
  onCleanup(() => {
    window.removeEventListener('dragenter', onDragEnter)
    window.removeEventListener('dragover', onDragOver)
    window.removeEventListener('dragleave', onDragLeave)
    window.removeEventListener('drop', onDrop)
  })

  // -------------------------------------------------- Drive wiring
  const driveConnected = () => editor.driveState().state === 'connected'
  const driveActions: DriveActions = {
    onConnect: () => void editor.connectDrive(),
    onDisconnect: () => void editor.disconnectDrive(),
    onLink: (mode) => void editor.linkToDrive(mode),
    onOpenFromDrive: () => void editor.openFromDrive(),
    onSaveNow: () => void editor.saveToDrive(),
    onKeepMine: () => void editor.saveToDrive(true),
    onTakeDrive: () => void editor.takeRemote(),
  }
  const sync = () => ({
    status: editor.saveStatus(),
    drive: editor.driveState(),
    storage: state.project?.storage ?? null,
    dirty: editor.isDirty(),
  })

  return (
    <div class="app" classList={{ 'is-narrow': narrow(), 'sidebar-open': sidebarOpen() && state.phase === 'ready' }}>
      <AppBar
        showSidebarToggle={state.phase === 'ready'}
        sidebarOpen={sidebarOpen()}
        onToggleSidebar={() => setSidebarOpen((o) => !o)}
        compact={phone()}
        isDemo={isDemo}
        project={
          <ProjectMenu
            projectName={state.project?.name ?? null}
            projectId={state.project?.id ?? null}
            projects={state.projects}
            driveConnected={driveConnected()}
            compact={phone()}
            onRename={editor.renameProject}
            onOpen={(id) => void editor.openProject(id)}
            onCreate={() => void newProject()}
            onImportArchive={() => void chooseArchive()}
            onDownloadArchive={() => void downloadArchive()}
            onExportCsv={() => void exportCsv()}
            onOpenFromDrive={driveActions.onOpenFromDrive}
            onDelete={() => void deleteProject()}
          />
        }
        status={<SaveStatusPill {...sync()} {...driveActions} compact={phone()} />}
        drive={<DriveButton {...sync()} {...driveActions} compact={narrow()} />}
      />

      <div class="app__body">
        <Show when={state.phase === 'ready' && state.project}>
          {(project) => (
            <>
              <aside
                id="sidebar"
                class="sidebar-wrap"
                aria-label="Images"
                aria-hidden={!sidebarOpen()}
                {...{ inert: !sidebarOpen() ? true : undefined }}
              >
                <Sidebar
                  project={project()}
                  currentImageId={state.currentImageId}
                  importing={state.importing}
                  driveConnected={driveConnected()}
                  imageCount={editor.imageCount}
                  thumbnail={thumbnails.url}
                  requestThumbnail={thumbnails.request}
                  onSelectImage={editor.selectImage}
                  onImportFiles={(gid) => void chooseImages(gid)}
                  onImportDrive={(gid) => void editor.importFromDrive(gid)}
                  onRenameProject={editor.renameProject}
                  onCreateImageGroup={() => editor.createImageGroup()}
                  onRenameImageGroup={editor.renameImageGroup}
                  onDeleteImageGroup={(id) => void deleteImageGroup(id)}
                  onMoveImageGroup={editor.moveImageGroup}
                  onAssignImage={editor.assignImage}
                  onRenameImage={(id) => void renameImage(id)}
                  onRemoveImage={(id) => void removeImage(id)}
                />
              </aside>
              <Show when={narrow() && sidebarOpen()}>
                <div class="scrim" aria-hidden="true" onClick={() => setSidebarOpen(false)} />
              </Show>
            </>
          )}
        </Show>

        <main class="app__main">
          <Switch>
            <Match when={state.phase === 'loading'}>
              <LoadingScreen label="Opening your projects…" />
            </Match>
            <Match when={state.phase === 'empty'}>
              <NoProject
                projects={state.projects}
                drive={editor.driveState()}
                onCreate={() => void newProject()}
                onImportArchive={() => void chooseArchive()}
                onOpen={(id) => void editor.openProject(id)}
                onOpenDrive={driveActions.onOpenFromDrive}
                onConnectDrive={driveActions.onConnect}
              />
            </Match>
            <Match when={state.phase === 'ready'}>
              <WorkspaceContainer
                dragging={dragging()}
                onImportFiles={() => void chooseImages(null)}
                onImportDrive={driveConnected() ? () => void editor.importFromDrive(null) : undefined}
              />
            </Match>
          </Switch>
        </main>
      </div>

      <Show when={dragging() && (state.phase !== 'ready' || (state.project?.images.length ?? 0) > 0)}>
        <div class="drop-overlay" aria-hidden="true">
          <div class="drop-overlay__card">
            <ImagePlus size={28} stroke-width={1.6} />
            <span>Drop images to import{state.project ? ` into “${state.project.name}”` : ''}</span>
          </div>
        </div>
      </Show>
      <Show when={state.busy}>
        <div class="busy-pill" role="status">
          <Loader class="spin" size={15} aria-hidden="true" /> {state.busy}
        </div>
      </Show>
      <ToastRegion toaster={toaster} />
      <DialogHost dialogs={props.dialogHost} />
    </div>
  )
}

function defaultProjectName(): string {
  return `Plates ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`
}
