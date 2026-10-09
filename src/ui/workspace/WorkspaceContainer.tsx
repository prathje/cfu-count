import { createMemo, createSignal, Show } from 'solid-js'
import { unwrap } from 'solid-js/store'
import { isConfirmed } from '../../model/annotations'
import type { ViewportHandle } from '../../viewport/api'
import { Viewport } from '../../viewport/Viewport'
import { useApp } from '../context'
import { createCurrentBitmap, type BlobSource } from '../images'
import { createElementWidth, createMediaQuery, MOD } from '../media'
import { CANVAS_GUARD_ATTR } from '../primitives'
import { FloatingToolbar, toolbarModeFor } from '../toolbar/FloatingToolbar'
import { displayOrder } from '../../model/project'
import { ImageHeader, type GroupTally } from './ImageHeader'
import { ViewportFooter } from './ViewportFooter'
import { NoImages } from './EmptyStates'
import { AlertTriangle, Loader } from '../icons'

/** Container: wires the editor to the image header, viewport, floating toolbar and footer. */
export interface WorkspaceContainerProps {
  onImportFiles(): void
  onImportDrive?: () => void
  dragging: boolean
}

export function WorkspaceContainer(props: WorkspaceContainerProps) {
  const { editor, dialogs } = useApp()
  const { state } = editor
  const [stage, setStage] = createSignal<HTMLElement>()
  const stageWidth = createElementWidth(stage)
  const mode = () => toolbarModeFor(stageWidth() || 1024)
  const coarse = createMediaQuery('(any-pointer: coarse)')
  const [scale, setScale] = createSignal<number | null>(null)
  let handle: ViewportHandle | undefined

  // Re-created per project so a project switch re-decodes even for an identical image id.
  const source = createMemo<BlobSource | null>(() => {
    const id = state.project?.id
    return id ? (imageId) => editor.getImageBlob(imageId) : null
  })
  const bitmap = createCurrentBitmap(() => state.currentImageId, source)

  const order = createMemo(() => (state.project ? displayOrder(state.project) : []))
  const position = () => order().findIndex((i) => i.id === state.currentImageId) + 1
  // Plain (unwrapped) records: the viewport iterates every point per redraw, and store
  // proxies would make it subscribe to each coordinate. Reading `updatedAt` here keeps
  // this memo (and therefore the viewport) reactive to in-place edits.
  const confirmed = createMemo(() =>
    editor
      .currentAnnotations()
      .filter((a) => (void a.updatedAt, isConfirmed(a)))
      .map((a) => unwrap(a)),
  )
  // Keep Fit clear of the floating toolbar (top) and the zoom footer (bottom).
  const fitInsets = { top: 64, right: 16, bottom: 56, left: 16 }
  const tallies = createMemo<GroupTally[]>(() =>
    editor.groups().map((g) => ({
      id: g.id,
      name: g.name,
      color: g.color,
      render: g.render,
      count: editor.groupCounts().get(g.id) ?? 0,
      hidden: g.hidden,
      locked: g.locked,
    })),
  )
  const imageGroupName = () => {
    const img = editor.currentImage()
    return state.project?.imageGroups.find((g) => g.id === img?.imageGroupId)?.name ?? null
  }

  const hint = () => {
    const g = editor.activeGroup()
    if (g?.hidden && state.tool !== 'pan') return `“${g.name}” is hidden — show it to edit`
    if (g?.locked && state.tool !== 'pan') return `“${g.name}” is locked — unlock to edit`
    if (coarse()) {
      if (state.tool === 'pan') return 'Drag to pan · pinch to zoom'
      const verb = state.tool === 'add' ? 'add' : 'erase'
      return state.touchAnnotates
        ? `Tap to ${verb} · two fingers to pan & zoom`
        : `Pencil taps ${verb} · drag to pan · pinch to zoom · turn on touch annotates to use fingers`
    }
    if (state.tool === 'add') return 'Click to add · drag to pan · scroll to zoom'
    if (state.tool === 'erase') return 'Click a marker to erase · drag to pan'
    return 'Drag to pan · scroll to zoom'
  }

  async function deleteGroup(id: string) {
    const g = editor.groupById(id)
    if (!g) return
    const usage = editor.groupUsage(id)
    const ok = await dialogs.confirm({
      title: `Delete “${g.name}”?`,
      body: usage.annotations
        ? `This removes ${usage.annotations.toLocaleString()} ${usage.annotations === 1 ? 'annotation' : 'annotations'} on ${usage.images} ${usage.images === 1 ? 'image' : 'images'}. This can’t be undone.`
        : 'This group has no annotations.',
      confirmLabel: 'Delete group',
      danger: true,
    })
    if (ok) editor.deleteGroup(id)
  }

  return (
    <section class="workspace" aria-label="Image workspace">
      <Show
        when={editor.currentImage()}
        fallback={
          <NoImages
            dragging={props.dragging}
            importing={state.importing}
            onImportFiles={props.onImportFiles}
            onImportDrive={props.onImportDrive}
          />
        }
      >
        {(image) => (
          <>
            <ImageHeader
              imageName={image().name}
              imageGroupName={imageGroupName()}
              width={image().width}
              height={image().height}
              total={editor.total()}
              tallies={tallies()}
              mismatch={image().sourceMismatch}
              position={position()}
              of={order().length}
              onPrevious={() => editor.selectAdjacentImage(-1)}
              onNext={() => editor.selectAdjacentImage(1)}
            />
            <div class="stage" ref={setStage} {...{ [CANVAS_GUARD_ATTR]: '' }}>
              <Viewport
                image={bitmap().status === 'ready' ? (bitmap() as { bitmap: ImageBitmap }).bitmap : null}
                imageWidth={image().width}
                imageHeight={image().height}
                annotations={confirmed()}
                fitInsets={fitInsets}
                groups={editor.groups()}
                activeGroupId={state.activeGroupId}
                tool={state.tool}
                touchAnnotates={state.touchAnnotates}
                onAdd={(x, y) => editor.addAnnotation(x, y)}
                onErase={(id) => editor.eraseAnnotation(id)}
                onBlocked={(reason) => editor.explainBlocked(reason)}
                onViewChange={(v) => setScale(v.scale)}
                ref={(h) => (handle = h)}
                label={`${image().name}: ${editor.total()} confirmed colonies. ${hint()}`}
              />
              <Show when={bitmap().status === 'loading'}>
                <div class="stage__overlay" role="status">
                  <Loader class="spin" size={20} aria-hidden="true" /> Loading image…
                </div>
              </Show>
              <Show when={bitmap().status === 'error' ? (bitmap() as { message: string }) : null}>
                {(err) => (
                  <div class="stage__overlay stage__overlay--error" role="alert">
                    <AlertTriangle size={20} aria-hidden="true" />
                    <div>
                      <strong>This image can’t be displayed.</strong>
                      <div>{err().message}</div>
                    </div>
                  </div>
                )}
              </Show>
              <div class="toolbar-dock">
                <FloatingToolbar
                  mode={mode()}
                  groups={editor.groups()}
                  counts={editor.groupCounts()}
                  activeGroup={editor.activeGroup()}
                  tool={state.tool}
                  canUndo={editor.canUndo()}
                  canRedo={editor.canRedo()}
                  mod={MOD}
                  onSelectGroup={editor.setActiveGroup}
                  onCreateGroup={() => editor.createGroup()}
                  onRenameGroup={editor.renameGroup}
                  onDeleteGroup={deleteGroup}
                  onMoveGroup={editor.moveGroup}
                  onToggleHidden={() => state.activeGroupId && editor.toggleHidden(state.activeGroupId)}
                  onToggleLocked={() => state.activeGroupId && editor.toggleLocked(state.activeGroupId)}
                  onStyleChange={(patch) => state.activeGroupId && editor.setGroupStyle(state.activeGroupId, patch)}
                  onTool={editor.setTool}
                  onUndo={editor.undo}
                  onRedo={editor.redo}
                />
              </div>
              <ViewportFooter
                scale={bitmap().status === 'ready' ? scale() : null}
                visible={editor.split().visible}
                hidden={editor.split().hidden}
                hint={hint()}
                compact={stageWidth() > 0 && stageWidth() < 700}
                showTouchToggle={coarse()}
                touchAnnotates={state.touchAnnotates}
                onZoomIn={() => handle?.zoomIn()}
                onZoomOut={() => handle?.zoomOut()}
                onFit={() => handle?.fit()}
                onActualSize={() => handle?.setScale(1)}
                onTouchAnnotates={editor.setTouchAnnotates}
              />
            </div>
          </>
        )}
      </Show>
    </section>
  )
}
