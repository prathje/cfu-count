import { createEffect, createSignal, Match, on, onCleanup, Show, Switch } from 'solid-js'
import { AppBar } from './appbar/AppBar'
import { DriveButton, SaveStatusPill, type DriveActions, type SyncInfo } from './appbar/DriveControls'
import { ProjectMenu } from './appbar/ProjectMenu'
import { SettingsMenu } from './appbar/SettingsMenu'
import { useApp } from './context'
import { createFileDrop } from './fileDrop'
import { ImagePlus, Loader } from './icons'
import { createMediaQuery, isApple, MOD } from './media'
import { DialogHost, ToastRegion } from './primitives'
import { shortcutSheet, useShortcuts } from './shortcuts'
import { ShortcutSheet } from './help/ShortcutSheet'
import type { ViewportHandle } from '../viewport/api'
import { SidebarContainer } from './sidebar/SidebarContainer'
import { LoadingScreen, NoProject } from './workspace/EmptyStates'
import { WorkspaceContainer } from './workspace/WorkspaceContainer'
import './app.css'

/** Top-level container: layout, drawer, global drop/shortcuts/persistence hooks, app bar wiring. */
export function AppShell() {
  const { editor, toaster, dialogs, thumbnails, actions, isDemo, assist, sound } = useApp()
  const { state, projects, drive } = editor
  const narrow = createMediaQuery('(max-width: 900px)')
  const phone = createMediaQuery('(max-width: 560px)')
  const touchScreen = createMediaQuery('(any-pointer: coarse)')
  const [sidebarOpen, setSidebarOpen] = createSignal(!narrow())
  const [helpOpen, setHelpOpen] = createSignal(false)
  const [adjustOpen, setAdjustOpen] = createSignal(false)
  let viewport: ViewportHandle | undefined
  const dragging = createFileDrop((files) => void actions.importFiles(files))

  // Drawer: closed by default on narrow screens, open on wide ones.
  createEffect(on(narrow, (n) => setSidebarOpen(!n), { defer: true }))
  // Selecting an image on a narrow screen closes the drawer.
  createEffect(on(() => state.currentImageId, () => narrow() && setSidebarOpen(false), { defer: true }))
  // Drawer: Escape closes it (popovers and dialogs handle their own Escape first).
  const drawerOpen = () => narrow() && sidebarOpen() && state.phase === 'ready'
  const onDrawerKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.defaultPrevented || !drawerOpen() || document.querySelector('dialog[open]')) return
    setSidebarOpen(false)
    document.querySelector<HTMLElement>('[aria-controls="sidebar"]')?.focus({ preventScroll: true })
  }
  window.addEventListener('keydown', onDrawerKey)
  onCleanup(() => window.removeEventListener('keydown', onDrawerKey))
  /** App-bar popovers open over the page: close the drawer so they never stack on top of it. */
  const dismissDrawer = () => drawerOpen() && setSidebarOpen(false)

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
        case 'zoom-in':
          return viewport?.zoomIn()
        case 'zoom-out':
          return viewport?.zoomOut()
        case 'fit':
          return viewport?.fit()
        case 'image':
          return editor.images.selectAdjacent(cmd.delta)
        case 'image-adjust':
          return setAdjustOpen((o) => !o)
        case 'find-similar':
          return assist.open() ? assist.setOpen(false) : assist.start()
        case 'help':
          return setHelpOpen(true)
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
    onDownloadArchive: () => void actions.downloadArchive(),
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
          <div class="contents" onClick={dismissDrawer}>
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
            onShowShortcuts={() => setHelpOpen(true)}
          />
          </div>
        }
        status={
          <div class="contents" onClick={dismissDrawer}>
            <SaveStatusPill {...sync()} {...driveActions} compact={phone()} />
          </div>
        }
        drive={
          <div class="contents" onClick={dismissDrawer}>
            <DriveButton {...sync()} {...driveActions} compact={narrow()} />
          </div>
        }
        settings={
          <div class="contents" onClick={dismissDrawer}>
            <SettingsMenu
              sound={sound.settings.get()}
              onSound={sound.settings.update}
              onPreview={sound.preview}
              audioUnavailable={sound.status() === 'unavailable'}
              appleTouch={isApple && touchScreen()}
              showTouch={touchScreen()}
              touchAnnotates={state.touchAnnotates}
              onTouchAnnotates={editor.view.setTouchAnnotates}
              onShowShortcuts={() => setHelpOpen(true)}
            />
          </div>
        }
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
              <WorkspaceContainer
                dragging={dragging()}
                onViewport={(h) => (viewport = h)}
                adjustOpen={adjustOpen()}
                onAdjustOpen={setAdjustOpen}
              />
            </Match>
          </Switch>
        </main>
      </div>

      <Show when={dragging() && (state.phase !== 'ready' || editor.images.order().length > 0)}>
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
      <ShortcutSheet open={helpOpen()} sections={shortcutSheet(MOD)} onClose={() => setHelpOpen(false)} />
    </div>
  )
}
