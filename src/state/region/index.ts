/**
 * Region selection controller ("Region" tool). Owns, for the app session:
 *  - one selection polygon per image (in memory only: never saved, never in
 *    undo history; dropped on project switch);
 *  - the region bar's actions: counts inside the region, "Clear N in region"
 *    (ONE undo step through annotations.applyBatch), "Find similar in region"
 *    (assist.start with the polygon as ROI) and "Compare with detector";
 *  - the latest comparison per image (in memory; never modifies annotations).
 *
 * The comparison runs on the assist controller's detector client (one Worker):
 * starting a comparison closes the review panel, and a Find similar run cancels
 * a comparison in flight.
 */
import { batch, createEffect, createMemo, createRoot, createSignal, on, untrack, type Accessor } from 'solid-js'
import { unwrap } from 'solid-js/store'
import type { Annotation, ID } from '../../model/types'
import type { AnnotationOp } from '../../model/annotations'
import { annotationsInRegion, regionTally, type Pt, type RegionPolygon, type RegionShape, type RegionTally } from '../../model/region'
import { newId as defaultNewId, now as defaultNow } from '../../model/ids'
import type { DetectProgress } from '../../detection'
import type { Editor } from '../editor'
import type { Assist } from '../assist'
import { nearDuplicates } from '../assist/review'
import type { Feedback } from '../feedback'
import type { Notify } from '../messages'
import {
  buildCompareRequest,
  compareCounts,
  compareMarks as marksFor,
  planComparison,
  summarizeComparison,
  typicalRadius,
  type CompareSeedMode,
  type Comparison,
} from './compare'

export * from './compare'

/** Ask before clearing more than this many annotations in one go. */
export const CLEAR_CONFIRM_ABOVE = 20

export interface RegionDeps {
  editor: Editor
  assist: Assist
  notify: Notify
  feedback?: Feedback
  /**
   * Version-history hook (editor.versions.beforeDestructive): awaited right before
   * "Clear in region" applies. Clearing one image is one undo step, so a failed
   * version only costs the Version history entry and the clear still proceeds
   * (same rule as clearing a group on one image).
   */
  beforeDestructive?: (label: string) => Promise<{ ok: boolean }>
  newId?: () => ID
  now?: () => string
}

export type ComparePhase = 'idle' | 'running' | 'error'

export interface ClearPlan {
  imageId: ID
  groupId: ID
  groupName: string
  ops: AnnotationOp[]
  manual: number
  automated: number
}

export interface RegionController {
  /** Region of the current image, or null. */
  current: Accessor<RegionPolygon | null>
  set(polygon: readonly Pt[]): void
  /** Forget the current image's region (and its comparison). */
  clear(): void
  shape: Accessor<RegionShape>
  setShape(shape: RegionShape): void
  /** Counts inside the current region for the active group (null without a region). */
  tally: Accessor<RegionTally | null>
  /** What "Clear in region" would remove, or null when there is nothing. */
  clearPlan(): ClearPlan | null
  /**
   * Remove the active group's annotations inside the region as ONE undo step.
   * Refuses (false) with the standard explanation and feedback when the group is
   * locked/hidden. No confirmation here (the UI asks above CLEAR_CONFIRM_ABOVE).
   */
  clearInRegion(plan?: ClearPlan | null): Promise<boolean>
  /** Open Find similar restricted to the region. */
  findSimilar(): void

  compareSeedMode: Accessor<CompareSeedMode>
  setCompareSeedMode(mode: CompareSeedMode): void
  /** Manual marks of the active group inside / outside the region. */
  compareCounts: Accessor<{ inside: number; outside: number } | null>
  comparePhase: Accessor<ComparePhase>
  compareProgress: Accessor<DetectProgress | null>
  compareError: Accessor<string | null>
  /** Latest comparison on the current image (also while stale). */
  comparison: Accessor<Comparison | null>
  /** The scored marks or the region changed since the comparison ran. */
  comparisonStale: Accessor<boolean>
  /** Overlay marks of the shown comparison (empty while hidden). */
  compareMarks: Accessor<readonly { x: number; y: number; r: number; kind: 'missed' | 'extra' | 'matched' }[]>
  compareVisible: Accessor<boolean>
  setCompareVisible(visible: boolean): void
  compare(): Promise<void>
  cancelCompare(): void
  dispose(): void
}

const isCancelled = (err: unknown) => err instanceof Error && err.name === 'DetectionCancelled'

/** Identity of a region (comparisons go stale when it changes). */
const regionKey = (p: readonly Pt[] | null) => (p ? p.map((q) => `${q.x},${q.y}`).join(';') : '')

export function createRegion(deps: RegionDeps): RegionController {
  return createRoot((disposeRoot) => {
    const { editor, assist, notify } = deps
    const feedback = deps.feedback ?? (() => {})
    const newId = deps.newId ?? defaultNewId
    const now = deps.now ?? defaultNow
    const { state, annotations, groups, images } = editor

    const [regions, setRegions] = createSignal<ReadonlyMap<ID, RegionPolygon>>(new Map())
    const [shape, setShape] = createSignal<RegionShape>('lasso')
    const [comparisons, setComparisons] = createSignal<ReadonlyMap<ID, Comparison>>(new Map())
    const [compareSeedMode, setCompareSeedMode] = createSignal<CompareSeedMode>('inside')
    const [comparePhase, setComparePhase] = createSignal<ComparePhase>('idle')
    const [compareProgress, setCompareProgress] = createSignal<DetectProgress | null>(null)
    const [compareError, setCompareError] = createSignal<string | null>(null)
    const [compareVisible, setCompareVisible] = createSignal(true)
    let abort: AbortController | null = null
    let token = 0

    const current = createMemo<RegionPolygon | null>(() => (state.currentImageId ? regions().get(state.currentImageId) ?? null : null))
    const tally = createMemo<RegionTally | null>(() => {
      const poly = current()
      return poly ? regionTally(annotations.current(), poly, state.activeGroupId) : null
    })
    const counts = createMemo(() => {
      const poly = current()
      const g = state.activeGroupId
      return poly && g ? compareCounts(annotations.current(), poly, g) : null
    })
    const comparison = createMemo<Comparison | null>(() => (state.currentImageId ? comparisons().get(state.currentImageId) ?? null : null))
    const comparisonStale = createMemo(() => {
      const c = comparison()
      if (!c) return false
      if (regionKey(current()) !== regionKey(c.region) || c.groupId !== state.activeGroupId) return true
      // the scored marks must still be there, unmoved, and no new manual mark of the group inside
      const byId = new Map(annotations.current().map((a) => [a.id, a]))
      if (c.plan.scored.some((a) => byId.get(a.id)?.x !== a.x || byId.get(a.id)?.y !== a.y)) return true
      const nowInside = counts()?.inside ?? 0
      return nowInside !== c.plan.scored.length + (c.plan.mode === 'inside' ? c.plan.seeds.length : 0)
    })
    const compareMarks = createMemo(() => {
      const c = comparison()
      if (!c || !compareVisible()) return []
      return marksFor(c.summary, c.plan.scored, c.result.suggestions)
    })

    function setForCurrent(poly: RegionPolygon | null) {
      const id = state.currentImageId
      if (!id) return
      setRegions((m) => {
        const n = new Map(m)
        if (poly) n.set(id, poly)
        else n.delete(id)
        return n
      })
    }

    function set(polygon: readonly Pt[]) {
      if (polygon.length < 3) return
      setForCurrent(polygon.map((p) => ({ x: p.x, y: p.y })))
    }

    function clear() {
      cancelCompare()
      const id = state.currentImageId
      batch(() => {
        setForCurrent(null)
        if (id) setComparisons((m) => dropKey(m, id))
      })
    }

    // ------------------------------------------------------------ clear in region
    function clearPlan(): ClearPlan | null {
      const poly = current()
      const imageId = state.currentImageId
      const group = groups.active()
      if (!poly || !imageId || !group) return null
      const inside = annotationsInRegion(annotations.current(), poly).filter((a) => a.groupId === group.id)
      if (!inside.length) return null
      return {
        imageId,
        groupId: group.id,
        groupName: group.name,
        ops: inside.map((annotation): AnnotationOp => ({ kind: 'remove', annotation: { ...unwrap(annotation) } as Annotation })),
        manual: inside.filter((a) => a.origin === 'manual').length,
        automated: inside.filter((a) => a.origin !== 'manual').length,
      }
    }

    /** Refusal checks shared before and after the version snapshot. */
    function refuse(given: ClearPlan | null | undefined): ClearPlan | null {
      const group = groups.active()
      if (!group) {
        annotations.explainBlocked('no-group')
        return null
      }
      if (annotations.explainGroupBlock(group.id)) return null
      const plan = given ?? clearPlan()
      if (!plan || plan.imageId !== state.currentImageId || plan.groupId !== group.id) {
        notify({ tone: 'info', key: 'region', message: `No “${group.name}” marks in this region` })
        feedback({ type: 'refused', reason: 'nothing-to-erase' })
        return null
      }
      return plan
    }

    async function clearInRegion(given?: ClearPlan | null): Promise<boolean> {
      let plan = refuse(given)
      if (!plan) return false
      let versionSaved = false
      if (deps.beforeDestructive) {
        const imageName = images.current()?.name ?? 'an image'
        versionSaved = (await deps.beforeDestructive(`Before clearing “${plan.groupName}” in a region of “${imageName}”`)).ok
        // edits were frozen while the version was stored; re-check, keeping only marks still there
        const still = new Set(annotations.current().map((a) => a.id))
        const ops = plan.ops.filter((o) => o.kind === 'remove' && still.has(o.annotation.id))
        plan = refuse({ ...plan, ops })
        if (!plan || plan.ops.length === 0) return false
      }
      const n = plan.ops.length
      const blocked = annotations.applyBatch(plan.imageId, plan.ops, { label: `Clear ${n} in region` })
      if (blocked) {
        if (blocked.reason === 'locked' || blocked.reason === 'hidden') annotations.explainBlocked(blocked.reason)
        else notify({ tone: 'warning', key: 'region', message: 'Couldn’t clear the region', detail: blocked.reason === 'invalid' ? blocked.detail : undefined })
        if (blocked.reason !== 'locked' && blocked.reason !== 'hidden') feedback({ type: 'refused', reason: blocked.reason })
        return false
      }
      feedback({ type: 'erased' })
      const imageId = plan.imageId
      const entryId = state.history[imageId]?.undo.at(-1)?.id
      notify({
        tone: 'success',
        key: 'region',
        message: `Removed ${n.toLocaleString()} ${n === 1 ? 'mark' : 'marks'} from “${plan.groupName}” in the region`,
        // same wording as ui/projectActions VERSION_SAVED_DETAIL
        detail: [plan.automated ? `${plan.manual} manual, ${plan.automated} automated.` : '', versionSaved ? 'A version was saved — restore it from Version history.' : ''].filter(Boolean).join(' ') || undefined,
        action: {
          label: 'Undo',
          run: () => {
            if (state.currentImageId === imageId && state.history[imageId]?.undo.at(-1)?.id === entryId) annotations.undo()
            else notify({ tone: 'info', key: 'region', message: 'Use Undo in the toolbar', detail: 'Other changes were made after clearing.' })
          },
        },
      })
      return true
    }

    function findSimilar() {
      const poly = current()
      if (!poly) return
      setCompareVisible(false)
      assist.start({ roi: poly })
    }

    // ------------------------------------------------------------ compare
    function cancelCompare() {
      if (!abort) return
      abort.abort()
      abort = null
      token++
      setCompareProgress(null)
      setComparePhase('idle')
    }

    async function compare() {
      const poly = current()
      const image = images.current()
      const group = groups.active()
      if (!poly || !image || !group) return
      if (image.sourceMismatch) {
        notify({ tone: 'warning', key: 'region', message: 'This image changed since it was counted', detail: 'Comparing is off until the image and its markers agree again.' })
        return
      }
      const planned = planComparison(annotations.current(), poly, group.id, compareSeedMode())
      if (!planned.ok) {
        notify({ tone: 'warning', key: 'region', message: planned.message, detail: planned.detail })
        return
      }
      const plan = planned.plan
      const settings = assist.settings()
      const request = buildCompareRequest({ image: unwrap(image), groupId: group.id, plan, region: poly, settings, runId: newId() })
      // one detector at a time: the review panel's search stops
      assist.setOpen(false)
      abort?.abort()
      const ac = new AbortController()
      abort = ac
      const mine = ++token
      const imageId = image.id
      const projectId = state.project?.id
      batch(() => {
        setComparePhase('running')
        setCompareError(null)
        setCompareProgress({ stage: 'prepare', fraction: 0 })
      })
      const t0 = performance.now()
      try {
        const blob = await images.blob(imageId)
        if (mine !== token) return
        const result = await assist.detector().detect({ ...request, source: { kind: 'blob', blob } }, { signal: ac.signal, onProgress: (p) => mine === token && setCompareProgress(p) })
        if (mine !== token || state.project?.id !== projectId) return
        // the review shows one circle per colony: drop the detector's near-duplicates too
        const dup = nearDuplicates(result.suggestions)
        const detected = result.suggestions.filter((_, i) => !dup.has(i))
        const rTyp = typicalRadius(result, 0.004 * Math.max(image.width, image.height))
        const summary = summarizeComparison(plan.scored, detected, rTyp)
        const c: Comparison = {
          imageId,
          groupId: group.id,
          region: poly.map((p) => ({ x: p.x, y: p.y })),
          plan,
          result: { suggestions: detected, calibration: result.calibration, roi: result.roi, run: result.run, timingsMs: result.timingsMs },
          summary,
          settings: { ...settings },
          createdAt: now(),
          elapsedMs: Math.round(performance.now() - t0),
        }
        batch(() => {
          setComparisons((m) => new Map(m).set(imageId, c))
          setCompareVisible(true)
          setComparePhase('idle')
        })
      } catch (err) {
        if (mine !== token) return
        if (isCancelled(err)) {
          setComparePhase('idle')
          return
        }
        console.error('Region comparison failed', err)
        batch(() => {
          setComparePhase('error')
          setCompareError(err instanceof Error && err.message ? `Comparison failed: ${err.message}` : 'Comparison failed.')
        })
      } finally {
        if (mine === token) {
          setCompareProgress(null)
          if (abort === ac) abort = null
        }
      }
    }

    // ------------------------------------------------------------ lifecycle
    createEffect(on(() => state.currentImageId, () => untrack(cancelCompare), { defer: true }))
    // A Find similar run takes the detector: a comparison in flight is cancelled by the client.
    createEffect(
      on(
        () => assist.phase(),
        (p) => {
          if (p === 'running' && untrack(comparePhase) === 'running') cancelCompare()
        },
        { defer: true },
      ),
    )
    createEffect(
      on(
        () => [state.project?.id, state.loadCount],
        () => {
          cancelCompare()
          batch(() => {
            setRegions(new Map())
            setComparisons(new Map())
            setCompareError(null)
          })
        },
        { defer: true },
      ),
    )

    return {
      current,
      set,
      clear,
      shape,
      setShape,
      tally,
      clearPlan,
      clearInRegion,
      findSimilar,
      compareSeedMode,
      setCompareSeedMode,
      compareCounts: counts,
      comparePhase,
      compareProgress,
      compareError,
      comparison,
      comparisonStale,
      compareMarks,
      compareVisible,
      setCompareVisible,
      compare,
      cancelCompare,
      dispose() {
        cancelCompare()
        disposeRoot()
      },
    }
  })
}

function dropKey<V>(m: ReadonlyMap<ID, V>, id: ID): ReadonlyMap<ID, V> {
  if (!m.has(id)) return m
  const n = new Map(m)
  n.delete(id)
  return n
}
