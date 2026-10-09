import { createMemo, createSignal, Show } from 'solid-js'
import { isConfirmed } from '../../model/annotations'
import type { ViewportHandle } from '../../viewport/api'
import { Viewport } from '../../viewport/Viewport'
import { useApp } from '../context'
import { bitmapError, bitmapSizeMismatch, createCurrentBitmap, readyImage, type BlobSource } from '../images'
import { createElementWidth, createMediaQuery, MOD } from '../media'
import { CANVAS_GUARD_ATTR } from '../primitives'
import { FloatingToolbar, toolbarModeFor } from '../toolbar/FloatingToolbar'
import { groupTallies, interactionHint, sizeMismatchMessage } from './hints'
import { ImageHeader } from './ImageHeader'
import { ViewportFooter } from './ViewportFooter'
import { NoImages } from './EmptyStates'
import { AlertTriangle, Loader } from '../icons'
import './workspace.css'

/** Container: wires the editor to the image header, viewport, floating toolbar and footer. */
export interface WorkspaceContainerProps {
  dragging: boolean
  /** Receives the viewport's zoom/fit handle (global shortcuts route through it). */
  onViewport?(handle: ViewportHandle): void
}

export function WorkspaceContainer(props: WorkspaceContainerProps) {
  const { editor, actions } = useApp()
  const { state, annotations, groups, images, view } = editor
  const [stage, setStage] = createSignal<HTMLElement>()
  const stageWidth = createElementWidth(stage)
  const mode = () => toolbarModeFor(stageWidth() || 1024)
  const coarse = createMediaQuery('(any-pointer: coarse)')
  const [scale, setScale] = createSignal<number | null>(null)
  let handle: ViewportHandle | undefined

  // Re-created per project so a project switch re-decodes even for an identical image id.
  const source = createMemo<BlobSource | null>(() => (state.project?.id ? images.blob : null))
  const bitmap = createCurrentBitmap(images.current, source)

  const position = () => images.order().findIndex((i) => i.id === state.currentImageId) + 1
  // Immutable snapshot (identity changes only on edits); filtering keeps that property.
  const confirmed = createMemo(() => annotations.current().filter(isConfirmed))
  // Keep Fit clear of the floating toolbar (top) and the zoom footer (bottom).
  const fitInsets = { top: 64, right: 16, bottom: 56, left: 16 }
  const tallies = createMemo(() => groupTallies(groups.list(), annotations.counts()))
  const imageGroupName = () => {
    const img = images.current()
    return state.project?.imageGroups.find((g) => g.id === img?.imageGroupId)?.name ?? null
  }
  const hint = () => interactionHint({ tool: state.tool, activeGroup: groups.active(), coarse: coarse(), touchAnnotates: state.touchAnnotates })
  const driveConnected = () => editor.drive.state().state === 'connected'

  return (
    <section class="workspace" aria-label="Image workspace">
      <Show
        when={images.current()}
        fallback={
          <NoImages
            dragging={props.dragging}
            importing={state.importing}
            onImportFiles={() => void actions.chooseImages(null)}
            onImportDrive={driveConnected() ? () => void images.importFromDrive(null) : undefined}
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
              total={annotations.total()}
              tallies={tallies()}
              mismatch={image().sourceMismatch}
              position={position()}
              of={images.order().length}
              onPrevious={() => images.selectAdjacent(-1)}
              onNext={() => images.selectAdjacent(1)}
            />
            <div class="stage" ref={setStage} {...{ [CANVAS_GUARD_ATTR]: '' }}>
              <Viewport
                image={readyImage(bitmap())?.source ?? null}
                imageWidth={image().width}
                imageHeight={image().height}
                annotations={confirmed()}
                fitInsets={fitInsets}
                groups={groups.list()}
                activeGroupId={state.activeGroupId}
                tool={state.tool}
                touchAnnotates={state.touchAnnotates}
                onAdd={annotations.add}
                onErase={annotations.erase}
                onBlocked={annotations.explainBlocked}
                onViewChange={(v) => setScale(v.scale)}
                ref={(h) => {
                  handle = h
                  props.onViewport?.(h)
                }}
                label={`${image().name}: ${annotations.total()} confirmed colonies. ${hint()}`}
              />
              <Show when={bitmap().status === 'loading'}>
                <div class="stage__overlay" role="status">
                  <Loader class="spin" size={20} aria-hidden="true" /> Loading image…
                </div>
              </Show>
              <Show when={bitmapError(bitmap())}>
                {(message) => (
                  <div class="stage__overlay stage__overlay--error" role="alert">
                    <AlertTriangle size={20} aria-hidden="true" />
                    <div>
                      <strong>This image can’t be displayed.</strong>
                      <div>{message()}</div>
                    </div>
                  </div>
                )}
              </Show>
              <Show when={bitmapSizeMismatch(bitmap())}>
                {(decoded) => (
                  <div class="stage__banner" role="alert">
                    <AlertTriangle size={16} aria-hidden="true" />
                    <span>{sizeMismatchMessage(image(), decoded())}</span>
                  </div>
                )}
              </Show>
              <div class="toolbar-dock">
                <FloatingToolbar
                  mode={mode()}
                  groups={groups.list()}
                  counts={annotations.counts()}
                  activeGroup={groups.active()}
                  tool={state.tool}
                  canUndo={annotations.canUndo()}
                  canRedo={annotations.canRedo()}
                  mod={MOD}
                  onSelectGroup={view.setActiveGroup}
                  onCreateGroup={() => groups.create()}
                  onRenameGroup={groups.rename}
                  onDeleteGroup={(id) => void actions.deleteAnnotationGroup(id)}
                  onMoveGroup={groups.move}
                  onToggleHidden={() => state.activeGroupId && groups.toggleHidden(state.activeGroupId)}
                  onToggleLocked={() => state.activeGroupId && groups.toggleLocked(state.activeGroupId)}
                  onStyleChange={(patch) => state.activeGroupId && groups.setStyle(state.activeGroupId, patch)}
                  onTool={view.setTool}
                  onUndo={annotations.undo}
                  onRedo={annotations.redo}
                />
              </div>
              <ViewportFooter
                scale={bitmap().status === 'ready' ? scale() : null}
                visible={annotations.split().visible}
                hidden={annotations.split().hidden}
                hint={hint()}
                compact={stageWidth() > 0 && stageWidth() < 700}
                showTouchToggle={coarse()}
                touchAnnotates={state.touchAnnotates}
                onZoomIn={() => handle?.zoomIn()}
                onZoomOut={() => handle?.zoomOut()}
                onFit={() => handle?.fit()}
                onActualSize={() => handle?.setScale(1)}
                onTouchAnnotates={view.setTouchAnnotates}
              />
            </div>
          </>
        )}
      </Show>
    </section>
  )
}
