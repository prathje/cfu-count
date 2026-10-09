import { createEffect, createSignal, Match, on, onCleanup, Show, Switch } from 'solid-js'
import { AppBar } from './appbar/AppBar'
import { DriveButton, SaveStatusPill, type DriveActions, type SyncInfo } from './appbar/DriveControls'
import { ProjectMenu } from './appbar/ProjectMenu'
import { useApp } from './context'
import { createFileDrop } from './fileDrop'
import { ImagePlus, Loader } from './icons'
import { createMediaQuery, isApple } from './media'
import { DialogHost, ToastRegion } from './primitives'
import { useShortcuts } from './shortcuts'
import { SidebarContainer } from './sidebar/SidebarContainer'
import { LoadingScreen, NoProject } from './workspace/EmptyStates'
import { WorkspaceContainer } from './workspace/WorkspaceContainer'
import './app.css'

/** Top-level container: layout, drawer, global drop/shortcuts/persistence hooks, app bar wiring. */
export function AppShell() {
  const { editor, toaster, dialogs, thumbnails, actions, isDemo } = useApp()
  const { state, projects, drive } = editor
  const narrow = createMediaQuery('(max-width: 900px)')
  const phone = createMediaQuery('(max-width: 560px)')
  const [sidebarOpen, setSidebarOpen] = createSignal(!narrow())
  const dragging = createFileDrop((files) => void actions.importFiles(files))

  // Drawer: closed by default on narrow screens, open on wide ones.
  createEffect(on(narrow, (n) => setSidebarOpen(!n), { defer: true }))
  // Selecting an image on a narrow screen closes the drawer.
  createEffect(on(() => state.currentImageId, () => narrow() && setSidebarOpen(false), { defer: true }))
  // Project switch: drop cached thumbnails.
  createEffect(on(() => state.project?.id, () => thumbnails.clear(), { defer: true }))

  // -------------------------------------------------- persistence lifecycle
  const flushNow = () => void projects.flush()
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
          return editor.view.setTool(cmd.tool)
        case 'toggle-visibility':
          return state.activeGroupId && editor.groups.toggleHidden(state.activeGroupId)
        case 'toggle-lock':
          return state.activeGroupId && editor.groups.toggleLocked(state.activeGroupId)
        case 'select-group':
          return editor.view.selectGroupByIndex(cmd.index)
        case 'undo':
          return editor.annotations.undo()
        case 'redo':
          return editor.annotations.redo()
      }
    },
    () => state.phase === 'ready',
  )

  // -------------------------------------------------- Drive wiring
  const driveConnected = () => drive.state().state === 'connected'
  const driveActions: DriveActions = {
    onConnect: () => void drive.connect(),
    onDisconnect: () => void drive.disconnect(),
    onLink: (mode) => void drive.link(mode),
    onOpenFromDrive: () => void drive.openFolder(),
    onSaveNow: () => void drive.save(),
    onKeepMine: () => void drive.save(true),
    onTakeDrive: () => void drive.takeRemote(),
  }
  const sync = (): SyncInfo => ({
    status: editor.saveStatus(),
    drive: drive.state(),
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
            onRename={projects.rename}
            onOpen={(id) => void projects.open(id)}
            onCreate={() => void actions.newProject()}
            onImportArchive={() => void actions.chooseArchive()}
            onDownloadArchive={() => void actions.downloadArchive()}
            onExportCsv={() => void actions.downloadCsv()}
            onOpenFromDrive={driveActions.onOpenFromDrive}
            onDelete={() => void actions.deleteProject()}
          />
        }
        status={<SaveStatusPill {...sync()} {...driveActions} compact={phone()} />}
        drive={<DriveButton {...sync()} {...driveActions} compact={narrow()} />}
      />

      <div class="app__body">
        <Show when={state.phase === 'ready' && state.project}>
          <aside
            id="sidebar"
            class="sidebar-wrap"
            aria-label="Images"
            aria-hidden={!sidebarOpen()}
            {...{ inert: !sidebarOpen() ? true : undefined }}
          >
            <SidebarContainer />
          </aside>
          <Show when={narrow() && sidebarOpen()}>
            <div class="scrim" aria-hidden="true" onClick={() => setSidebarOpen(false)} />
          </Show>
        </Show>

        <main class="app__main">
          <Switch>
            <Match when={state.phase === 'loading'}>
              <LoadingScreen label="Opening your projects…" />
            </Match>
            <Match when={state.phase === 'empty'}>
              <NoProject
                projects={state.projects}
                drive={drive.state()}
                onCreate={() => void actions.newProject()}
                onImportArchive={() => void actions.chooseArchive()}
                onOpen={(id) => void projects.open(id)}
                onOpenDrive={driveActions.onOpenFromDrive}
                onConnectDrive={driveActions.onConnect}
              />
            </Match>
            <Match when={state.phase === 'ready'}>
              <WorkspaceContainer dragging={dragging()} />
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
        {(busy) => (
          <>
            <Show when={busy().blocking}>
              <div class="busy-scrim" aria-hidden="true" />
            </Show>
            <div class="busy-pill" role="status">
              <Loader class="spin" size={15} aria-hidden="true" /> {busy().label}
            </div>
          </>
        )}
      </Show>
      <ToastRegion toaster={toaster} />
      <DialogHost dialogs={dialogs} />
    </div>
  )
}
