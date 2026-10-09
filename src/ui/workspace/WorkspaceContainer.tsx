import { createEffect, createMemo, createSignal, on, onCleanup, Show } from 'solid-js'
import { normaliseDisplay, isDefaultDisplay } from '../../model/display'
import { imagesInGroup } from '../../model/project'
import type { ImageDisplayAdjust } from '../../model/types'
import { isConfirmed, labelNumber } from '../../model/annotations'
import type { AddInfo, BlockedReason, ReviewClusterMark, SuggestionMark, ViewportHandle } from '../../viewport/api'
import { MIN_SEEDS, stageLabel, type AcceptScope } from '../../state/assist'
import { ReviewPanel, type ReviewSummary } from '../assist/ReviewPanel'
import { Viewport } from '../../viewport/Viewport'
import { useApp } from '../context'
import { bitmapError, bitmapSizeMismatch, createCurrentBitmap, readyImage, type BlobSource } from '../images'
import { createElementHeight, createElementWidth, createMediaQuery, MOD } from '../media'
import { CANVAS_GUARD_ATTR, Popover } from '../primitives'
import { COMPARE_KEY, FIND_SIMILAR_KEY, isTypingTarget } from '../shortcuts'
import { AdjustPanel } from './AdjustPanel'
import { FloatingToolbar, toolbarModeFor } from '../toolbar/FloatingToolbar'
import { groupTallies, interactionHint, nearDuplicateMessage, sizeMismatchMessage, TOUCH_NAVIGATES_DETAIL, TOUCH_NAVIGATES_MESSAGE } from './hints'
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
  /** Image adjustments popover state (the "I" shortcut lives in the app shell). */
  adjustOpen: boolean
  onAdjustOpen(open: boolean): void
}

/** The "fingers only navigate" explanation is shown once per page session. */
let touchNavigatesExplained = false

export function WorkspaceContainer(props: WorkspaceContainerProps) {
  const { editor, actions, toaster, assist } = useApp()
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
  // Keep Fit clear of the floating toolbar (top) and the zoom footer (bottom); both grow on touch screens.
  const baseInsets = () => (coarse() ? { top: 72, right: 16, bottom: 74, left: 16 } : { top: 64, right: 16, bottom: 62, left: 16 })
  // The review panel covers a corner (wide stages) or the bottom (sheet): keep Fit and region focus clear of it.
  const [panelEl, setPanelEl] = createSignal<HTMLElement>()
  const panelHeight = createElementHeight(() => (assist.open() ? panelEl() : undefined))
  const sheet = () => stageWidth() > 0 && stageWidth() < 600
  const fitInsets = () => {
    const b = baseInsets()
    if (!assist.open()) return b
    if (sheet()) return { ...b, bottom: Math.max(b.bottom, panelHeight() + 8) }
    return { ...b, right: 348 + 24 }
  }
  const tallies = createMemo(() => groupTallies(groups.list(), annotations.counts()))
  const imageGroupName = () => {
    const img = images.current()
    return state.project?.imageGroups.find((g) => g.id === img?.imageGroupId)?.name ?? null
  }
  const baseHint = () => interactionHint({ tool: state.tool, activeGroup: groups.active(), coarse: coarse(), touchAnnotates: state.touchAnnotates })
  const hint = () => (suggestionMarks().length ? `${coarse() ? 'Tap' : 'Click'} a dashed ring to reject or restore it · ${baseHint()}` : baseHint())
  const driveConnected = () => editor.drive.state().state === 'connected'

  // ------------------------------------------------ display adjustments (view setting)
  const [adjustAnchor, setAdjustAnchor] = createSignal<HTMLElement>()
  const [comparing, setComparing] = createSignal(false)
  const display = createMemo(() => normaliseDisplay(images.current()?.display))
  const groupImages = () => {
    const img = images.current()
    return state.project && img ? imagesInGroup(state.project, img.imageGroupId) : []
  }
  function applyDisplayTo(ids: string[], what: string) {
    const value: ImageDisplayAdjust = { ...display() }
    images.setDisplay(ids, value)
    toaster.push({ tone: 'success', key: 'display-apply', message: `${isDefaultDisplay(value) ? 'Reset display for' : 'Applied display settings to'} ${what}` })
  }
  // Hold "\\" to show the original (keyup ends it; so do blur and hiding the tab).
  const onCompareKey = (e: KeyboardEvent) => {
    if (e.key !== COMPARE_KEY || e.metaKey || e.ctrlKey || isTypingTarget(e.target) || document.querySelector('dialog[open]')) return
    if (!images.current() || isDefaultDisplay(display())) return
    e.preventDefault()
    setComparing(e.type === 'keydown')
  }
  const endCompare = () => setComparing(false)
  window.addEventListener('keydown', onCompareKey)
  window.addEventListener('keyup', onCompareKey)
  window.addEventListener('blur', endCompare)
  onCleanup(() => {
    window.removeEventListener('keydown', onCompareKey)
    window.removeEventListener('keyup', onCompareKey)
    window.removeEventListener('blur', endCompare)
  })

  // ------------------------------------------------ assisted counting (review overlay + panel)
  createEffect(() => assist.setSizeMismatch(!!bitmapSizeMismatch(bitmap())))
  const pending = assist.view
  const [reviewIdx, setReviewIdx] = createSignal(0)
  // Pending rings, plus the runner-up explanation of the selected review region (for comparison).
  const suggestionMarks = createMemo<readonly (SuggestionMark & { index: number })[]>(() => {
    const v = assist.open() ? pending() : null
    if (!v) return []
    const alt = currentReview()?.cluster.alternative?.colonies ?? []
    return alt.length ? [...v.marks, ...alt.map((c) => ({ ...c, state: 'alternative' as const, index: -1 }))] : v.marks
  })
  createEffect(on(() => assist.layer()?.result, () => setReviewIdx(0)))
  const reviewList = () => pending()?.reviewClusters ?? []
  const currentReview = () => {
    const list = reviewList()
    if (!list.length) return null
    const i = Math.min(reviewIdx(), list.length - 1)
    return { position: i + 1, total: list.length, cluster: list[i] }
  }
  const clusterMarks = createMemo<readonly ReviewClusterMark[]>(() => {
    const v = pending()
    if (!assist.open() || !v) return []
    const active = currentReview()?.cluster.clusterId
    return [
      ...v.reviewClusters.map((c) => ({ bbox: c.bbox, label: c.question, active: c.clusterId === active, kind: 'review' as const })),
      ...v.tooLarge.map((c) => ({ bbox: c.bbox, label: 'Count by hand', active: false, kind: 'too-large' as const })),
    ]
  })
  function focusReview(i: number) {
    const list = reviewList()
    if (!list.length) return
    const k = ((i % list.length) + list.length) % list.length
    setReviewIdx(k)
    const [x, y, w, h] = list[k].bbox
    handle?.showRect(x, y, w, h)
  }
  function accept(scope: AcceptScope) {
    if (!assist.accept(scope)) return
    // The resolved region drops out of the list: show the one that took its place.
    if (scope.kind === 'cluster' && reviewList().length) focusReview(Math.min(reviewIdx(), reviewList().length - 1))
  }
  const assistGroup = () => {
    const g = assist.targetGroup()
    return g ? { name: g.name, color: g.color, render: g.render } : null
  }
  const assistBlock = () => {
    const b = assist.block()
    if (!b) return null
    const g = groups.active()
    const fix =
      g && b.reason === 'locked'
        ? { label: 'Unlock', run: () => groups.setLocked(g.id, false) }
        : g && b.reason === 'hidden'
          ? { label: 'Show group', run: () => groups.setHidden(g.id, false) }
          : b.reason === 'no-seeds' && state.tool !== 'add'
            ? { label: 'Use Add tool', run: () => view.setTool('add') }
            : undefined
    return { message: b.message, detail: b.detail, fix }
  }
  const assistSummary = createMemo<ReviewSummary | null>(() => {
    const l = assist.layer()
    const v = pending()
    if (!l || !v) return null
    const ref = l.reference ? state.project?.images.find((i) => i.id === l.reference!.imageId) : undefined
    return {
      suggested: v.suggested,
      needReview: v.needReview,
      rejected: v.rejected,
      okCount: v.okIndices.length,
      tooLarge: v.tooLarge.length,
      calibration: l.result.calibration,
      rimPx: l.result.roi.marginPx,
      elapsedMs: l.elapsedMs,
      detectorMs: typeof l.result.timingsMs.total === 'number' ? l.result.timingsMs.total : null,
      referenceName: l.reference ? ref?.name ?? 'another image' : null,
    }
  })
  const toggleAssist = () => (assist.open() ? assist.setOpen(false) : assist.start())
  // Escape closes the review panel (popovers and dialogs handle their own Escape first).
  const onAssistKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.defaultPrevented || !assist.open() || isTypingTarget(e.target) || document.querySelector('dialog[open]')) return
    assist.setOpen(false)
  }
  window.addEventListener('keydown', onAssistKey)
  onCleanup(() => window.removeEventListener('keydown', onAssistKey))

  function onAdd(x: number, y: number, info: AddInfo) {
    const list = confirmed() // snapshot before the add: the near marker is in it
    if (!annotations.add(x, y) || !info.nearAnnotationId) return
    const near = list.find((a) => a.id === info.nearAnnotationId)
    const added = annotations.current().at(-1)
    if (!near || !added) return
    const nearGroup = groups.list().find((g) => g.id === near.groupId)
    toaster.push({
      tone: 'info',
      key: 'near-duplicate',
      message: nearDuplicateMessage({
        groupName: nearGroup?.name ?? 'another group',
        number: labelNumber(list, near.id),
        sameGroup: near.groupId === added.groupId,
      }),
      detail: 'Both markers are kept. Undo if it was a double tap.',
      action: { label: 'Undo', run: () => annotations.erase(added.id) },
    })
  }

  function onBlocked(reason: BlockedReason) {
    if (reason !== 'touch-navigates') return annotations.explainBlocked(reason)
    if (touchNavigatesExplained || state.touchAnnotates) return
    touchNavigatesExplained = true
    toaster.push({
      tone: 'info',
      key: 'touch-navigates',
      message: TOUCH_NAVIGATES_MESSAGE,
      detail: TOUCH_NAVIGATES_DETAIL,
      action: { label: 'Turn on', run: () => view.setTouchAnnotates(true) },
    })
  }

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
              suggested={pending()?.suggested ?? 0}
              onShowSuggestions={() => assist.start()}
            />
            <div class="stage" ref={setStage} {...{ [CANVAS_GUARD_ATTR]: '' }}>
              {/* DOM order = visual/tab order: toolbar, image, footer. */}
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
                  assist={{
                    open: assist.open(),
                    blockedReason: assist.block()?.message ?? null,
                    shortcut: FIND_SIMILAR_KEY.toUpperCase(),
                    onClick: toggleAssist,
                  }}
                />
              </div>
              <Viewport
                image={readyImage(bitmap())?.source ?? null}
                imageWidth={image().width}
                imageHeight={image().height}
                annotations={confirmed()}
                fitInsets={fitInsets()}
                groups={groups.list()}
                activeGroupId={state.activeGroupId}
                tool={state.tool}
                touchAnnotates={state.touchAnnotates}
                adjust={image().display}
                compareOriginal={comparing()}
                suggestions={suggestionMarks()}
                suggestionColor={assist.targetGroup()?.color}
                reviewClusters={clusterMarks()}
                onSuggestionTap={assist.open() ? (i) => {
                  const m = suggestionMarks()[i]
                  if (m && m.index >= 0) assist.toggleReject(m.index)
                } : undefined}
                onAdd={onAdd}
                onErase={annotations.erase}
                onBlocked={onBlocked}
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
                adjustActive={!isDefaultDisplay(display())}
                adjustOpen={props.adjustOpen}
                comparing={comparing()}
                onToggleAdjust={() => props.onAdjustOpen(!props.adjustOpen)}
                adjustRef={setAdjustAnchor}
              />
              <Popover
                open={props.adjustOpen}
                anchor={adjustAnchor()}
                onClose={() => {
                  setComparing(false)
                  props.onAdjustOpen(false)
                }}
                label="Image adjustments"
                placement="top-start"
                width={320}
                class={comparing() ? 'is-comparing' : ''}
              >
                <AdjustPanel
                  value={display()}
                  imageGroupName={imageGroupName()}
                  imageCount={images.order().length}
                  groupImageCount={groupImages().length}
                  comparing={comparing()}
                  compareKey={COMPARE_KEY}
                  onChange={(next) => images.setDisplay([image().id], next)}
                  onReset={() => images.setDisplay([image().id], null)}
                  onApplyAll={() => applyDisplayTo(images.order().map((i) => i.id), `all ${images.order().length} images`)}
                  onApplyGroup={() => applyDisplayTo(groupImages().map((i) => i.id), `“${imageGroupName()}”`)}
                  onCompare={setComparing}
                />
              </Popover>
              <Show when={assist.open()}>
                <ReviewPanel
                  ref={setPanelEl}
                  sheet={sheet()}
                  group={assistGroup()}
                  block={assistBlock()}
                  phase={assist.phase()}
                  progress={assist.progress() ? { label: stageLabel(assist.progress()), fraction: assist.progress()!.fraction } : null}
                  error={assist.error()}
                  localSeeds={assist.localSeeds()}
                  minSeeds={MIN_SEEDS}
                  candidates={assist.candidates()}
                  seedSource={assist.seedSource()}
                  onSeedSource={assist.setSeedSource}
                  summary={assistSummary()}
                  settings={assist.settings()}
                  onSettings={assist.setSettings}
                  review={currentReview()}
                  onPrevReview={() => focusReview(reviewIdx() - 1)}
                  onNextReview={() => focusReview(reviewIdx() + 1)}
                  onAcceptPrimary={() => {
                    const c = currentReview()
                    if (c) accept({ kind: 'cluster', clusterId: c.cluster.clusterId, choice: 'primary' })
                  }}
                  onAcceptAlternative={() => {
                    const c = currentReview()
                    if (c) accept({ kind: 'cluster', clusterId: c.cluster.clusterId, choice: 'alternative' })
                  }}
                  onAcceptOk={() => accept({ kind: 'ok' })}
                  onRejectAll={assist.discard}
                  onRun={assist.run}
                  onCancel={assist.cancel}
                  onClose={() => assist.setOpen(false)}
                />
              </Show>
            </div>
          </>
        )}
      </Show>
    </section>
  )
}
