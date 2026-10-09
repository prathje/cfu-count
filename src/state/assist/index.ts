/**
 * Assisted counting controller ("Find similar"). Owns, for the app session:
 *  - one detector client (one Worker, created on first use, disposed with the app);
 *  - the in-memory suggestion store (one layer per image; never saved, never
 *    counted, never in undo history; cleared on project switch);
 *  - the review panel's state (open, phase, progress, settings, seed source).
 *
 * It reads the editor and writes ONLY through editor.annotations: applyBatch, so
 * an accept is one undo step that also stores (and on undo removes) the run, and
 * setRunRecord for the layer's reject-only run (rejections without an accept; not
 * an undo step, kept in sync with the layer's rejections).
 * Pure rules live in review.ts (layer, pending view, accept plan) and seeds.ts.
 */
import { batch, createEffect, createMemo, createRoot, createSignal, on, untrack, type Accessor } from 'solid-js'
import { unwrap } from 'solid-js/store'
import type { AnnotationGroup, ID } from '../../model/types'
import { editBlock } from '../../model/policy'
import { newId as defaultNewId, now as defaultNow } from '../../model/ids'
import type { DetectorClient, DetectProgress } from '../../detection'
import type { Editor } from '../editor'
import type { Notify } from '../messages'
import {
  DEFAULT_REVIEW_SETTINGS,
  carryRejections,
  emptyStore,
  makeLayer,
  noteAccepted,
  pendingView,
  planAccept,
  planRejectRun,
  pruneStore,
  putLayer,
  rejectAllPending,
  restoreAllRejected,
  toggleRejected,
  updateLayer,
  type AcceptScope,
  type PendingView,
  type ReviewSettings,
  type SuggestionLayer,
  type SuggestionStore,
} from './review'
import {
  MIN_SEEDS,
  buildRequest,
  defaultSeedSource,
  findBlock,
  referenceCandidates,
  seedAnnotations,
  type FindBlock,
  type ReferenceCandidate,
  type SeedSource,
} from './seeds'

export * from './review'
export * from './seeds'

export type AssistPhase = 'idle' | 'running' | 'ready' | 'error'

export interface AssistDeps {
  editor: Editor
  notify: Notify
  /** Creates the Worker-backed client; called once, on the first run. */
  createClient(): DetectorClient
  /** Debounce for slider re-runs, in ms (default 450). */
  debounceMs?: number
  newId?: () => ID
  now?: () => string
}

export interface Assist {
  /** The review panel is open (suggestions are drawn and tappable only then). */
  open: Accessor<boolean>
  setOpen(open: boolean): void
  /** Open the panel; starts a run right away when this image has enough examples and nothing to show yet. */
  start(): void
  /** Why Find similar is unavailable on the current image, or null. */
  block: Accessor<FindBlock | null>
  /** Manual examples of the active group on this image. */
  localSeeds: Accessor<number>
  /** Other images that can lend examples. */
  candidates: Accessor<ReferenceCandidate[]>
  seedSource: Accessor<SeedSource>
  setSeedSource(source: SeedSource): void
  phase: Accessor<AssistPhase>
  progress: Accessor<DetectProgress | null>
  error: Accessor<string | null>
  /** Layer of the current image, or null. */
  layer: Accessor<SuggestionLayer | null>
  /** Pending suggestions on the current image (derived from the layer and current annotations). */
  view: Accessor<PendingView | null>
  /** Group the current layer's suggestions are for (else the active group). */
  targetGroup: Accessor<AnnotationGroup | undefined>
  settings: Accessor<ReviewSettings>
  /** Change settings; re-runs (debounced) when there are results or a run in flight. */
  setSettings(patch: Partial<ReviewSettings>): void
  run(): void
  cancel(): void
  toggleReject(index: number): void
  /** Accept a scope as ONE undo step. Refuses (with an explanation) on locked/hidden groups. */
  accept(scope: AcceptScope): boolean
  /**
   * Reject every pending suggestion on this image. Rejections stay restorable
   * (toggleReject, restoreAll) and are recorded as a reject-only DetectionRun.
   */
  rejectAll(): void
  /** Restore every rejected suggestion on this image. */
  restoreAll(): void
  /** Tell the controller whether the decoded picture's size matches the record. */
  setSizeMismatch(mismatch: boolean): void
  dispose(): void
}

function errorMessage(err: unknown): string {
  const code = (err as { code?: string } | null)?.code
  if (code === 'decode-failed') return 'The image couldn’t be decoded for analysis in this browser.'
  if (code === 'out-of-memory') return 'Not enough memory to analyse this image on this device. Close other tabs and try again.'
  if (err instanceof Error && err.message) return `Analysis failed: ${err.message}`
  return 'Analysis failed for an unknown reason.'
}

const isCancelled = (err: unknown) => err instanceof Error && err.name === 'DetectionCancelled'

export function createAssist(deps: AssistDeps): Assist {
  return createRoot((disposeRoot) => {
    const { editor, notify } = deps
    const { state, annotations, images, groups } = editor
    const newId = deps.newId ?? defaultNewId
    const now = deps.now ?? defaultNow
    const debounceMs = deps.debounceMs ?? 450

    const [open, setOpenSignal] = createSignal(false)
    const [store, setStore] = createSignal<SuggestionStore>(emptyStore())
    const [phase, setPhase] = createSignal<AssistPhase>('idle')
    const [progress, setProgress] = createSignal<DetectProgress | null>(null)
    const [error, setError] = createSignal<string | null>(null)
    const [settings, setSettingsSignal] = createSignal<ReviewSettings>({ ...DEFAULT_REVIEW_SETTINGS })
    const [sizeMismatch, setSizeMismatch] = createSignal(false)
    const [explicitSource, setExplicitSource] = createSignal<ReadonlyMap<ID, SeedSource>>(new Map())

    let client: DetectorClient | null = null
    let abort: AbortController | null = null
    let token = 0
    let timer: ReturnType<typeof setTimeout> | undefined

    const layer = createMemo<SuggestionLayer | null>(() => (state.currentImageId ? store().get(state.currentImageId) ?? null : null))
    const view = createMemo<PendingView | null>(() => {
      const l = layer()
      return l ? pendingView(l, annotations.current()) : null
    })
    const targetGroup = createMemo(() => {
      const l = layer()
      return l ? groups.list().find((g) => g.id === l.groupId) : groups.active()
    })
    const localSeeds = createMemo(() => {
      const g = groups.active()
      return g ? seedAnnotations(annotations.current(), g.id).length : 0
    })
    const candidates = createMemo<ReferenceCandidate[]>(() => {
      const g = groups.active()
      if (!g || !state.project) return []
      return referenceCandidates(state.project.images, state.docs, g.id, state.currentImageId)
    })
    const seedSource = createMemo<SeedSource>(() => {
      const id = state.currentImageId
      const chosen = id ? explicitSource().get(id) : undefined
      if (chosen?.kind === 'this-image' && localSeeds() > 0) return chosen
      if (chosen?.kind === 'reference' && candidates().some((c) => c.imageId === chosen.imageId)) return chosen
      return defaultSeedSource(localSeeds(), candidates())
    })
    const block = createMemo(() =>
      findBlock({
        image: images.current(),
        group: groups.active(),
        sizeMismatch: sizeMismatch(),
        localSeeds: localSeeds(),
        referenceCount: candidates().length,
      }),
    )

    // ------------------------------------------------------------ running
    function cancel() {
      clearTimeout(timer)
      timer = undefined
      if (!abort) return
      abort.abort()
      abort = null
      token++
      setProgress(null)
      setPhase(layer() ? 'ready' : 'idle')
    }

    async function runNow() {
      clearTimeout(timer)
      timer = undefined
      const image = images.current()
      const group = groups.active()
      const project = state.project
      const b = block()
      if (b || !image || !group || !project) {
        if (b) notify({ tone: 'warning', key: 'assist', message: b.message, detail: b.detail })
        return
      }
      const source = seedSource()
      const ref = source.kind === 'reference' ? project.images.find((i) => i.id === source.imageId) : undefined
      const s = settings()
      const request = buildRequest({
        image: unwrap(image),
        groupId: group.id,
        annotations: annotations.current(),
        reference: ref ? { image: unwrap(ref), annotations: unwrap(state.docs[ref.id]?.annotations) ?? [] } : undefined,
        settings: s,
        runId: newId(),
      })
      if (source.kind === 'this-image') delete request.remoteSeeds
      const nSeeds = request.seeds.length + (request.remoteSeeds?.length ?? 0)
      if (nSeeds === 0) {
        notify({ tone: 'warning', key: 'assist', message: `Mark a few colonies in “${group.name}” first`, detail: `The search needs ${MIN_SEEDS} or more examples.` })
        return
      }
      abort?.abort()
      const ac = new AbortController()
      abort = ac
      const mine = ++token
      const projectId = project.id
      batch(() => {
        setPhase('running')
        setError(null)
        setProgress({ stage: 'prepare', fraction: 0 })
      })
      const t0 = performance.now()
      const acceptsAtStart = untrack(store).get(image.id)?.acceptRunIds
      try {
        const blob = await images.blob(image.id)
        const remote = ref ? { [ref.id]: await images.blob(ref.id) } : undefined
        if (mine !== token) return
        client ??= deps.createClient()
        const result = await client.detect(
          { ...request, source: { kind: 'blob', blob }, ...(remote ? { remoteSources: remote } : {}) },
          { signal: ac.signal, onProgress: (p) => mine === token && setProgress(p) },
        )
        if (mine !== token || state.project?.id !== projectId) return
        const prev = untrack(store).get(image.id)
        if (prev && prev.acceptRunIds !== acceptsAtStart) {
          // Suggestions were accepted while this run computed: its result does not know
          // those marks and would bring resolved regions back as pending. Run again.
          if (state.currentImageId === image.id && untrack(open)) scheduleRun(0)
          else setPhase('ready')
          return
        }
        const next = makeLayer({
          imageId: image.id,
          imageFingerprint: image.fingerprint,
          groupId: group.id,
          result,
          settings: s,
          reference: ref ? { imageId: ref.id, fingerprint: ref.fingerprint } : null,
          elapsedMs: Math.round(performance.now() - t0),
          rejected: prev && prev.groupId === group.id ? carryRejections(prev, result.suggestions) : undefined,
          rejectRunId: newId(),
        })
        batch(() => {
          setStore((st) => putLayer(st, next))
          if (state.currentImageId === image.id) setPhase('ready')
        })
      } catch (err) {
        if (mine !== token) return
        if (isCancelled(err)) {
          setPhase(untrack(layer) ? 'ready' : 'idle')
          return
        }
        console.error('Assisted counting failed', err)
        batch(() => {
          setPhase('error')
          setError(errorMessage(err))
        })
      } finally {
        if (mine === token) {
          setProgress(null)
          if (abort === ac) abort = null
        }
      }
    }

    function scheduleRun(delay: number) {
      clearTimeout(timer)
      timer = setTimeout(() => void runNow(), delay)
    }

    function setSettings(patch: Partial<ReviewSettings>) {
      const prev = settings()
      const next = { ...prev, ...patch }
      setSettingsSignal(next)
      if (!open() || (!layer() && phase() !== 'running')) return
      scheduleRun(patch.method && patch.method !== prev.method ? 0 : debounceMs)
    }

    function setOpen(next: boolean) {
      if (!next) cancel()
      setOpenSignal(next)
    }

    function start() {
      setOpenSignal(true)
      if (layer() || phase() === 'running' || block()) return
      if (seedSource().kind === 'this-image' && localSeeds() >= MIN_SEEDS) void runNow()
    }

    // ------------------------------------------------------------ review
    function toggleReject(index: number) {
      const id = state.currentImageId
      if (id) setStore((st) => updateLayer(st, id, (l) => toggleRejected(l, index)))
    }

    function rejectAll() {
      const id = state.currentImageId
      const v = view()
      if (id && v) setStore((st) => updateLayer(st, id, (l) => rejectAllPending(l, v)))
    }

    function restoreAll() {
      const id = state.currentImageId
      if (id) setStore((st) => updateLayer(st, id, restoreAllRejected))
    }

    /** Keep the layer's reject-only run record in step with its rejections. */
    function syncRejectRun(l: SuggestionLayer, v: PendingView) {
      const runs = state.docs[l.imageId]?.detectionRuns ?? []
      const existing = runs.find((r) => r.runId === l.rejectRunId)
      const wanted = planRejectRun(l, v, new Set(runs.map((r) => r.runId)), existing?.createdAt ?? now())
      if (!wanted && !existing) return
      if (wanted && existing && JSON.stringify(wanted.negatives) === JSON.stringify(existing.negatives)) return
      annotations.setRunRecord(l.imageId, l.rejectRunId, wanted)
    }

    function accept(scope: AcceptScope): boolean {
      const l = layer()
      const v = view()
      const image = images.current()
      if (!l || !v || !image || state.currentImageId !== l.imageId) return false
      if (image.sourceMismatch || image.fingerprint !== l.imageFingerprint) {
        notify({ tone: 'warning', key: 'assist', message: 'Can’t accept: the image changed', detail: 'These suggestions were computed on different image bytes. Run Find similar again.' })
        return false
      }
      const group = groups.list().find((g) => g.id === l.groupId)
      const reason = editBlock(group)
      if (reason || !group) {
        const name = group?.name ?? 'the group'
        notify({
          tone: 'warning',
          key: 'assist',
          message: reason === 'locked' ? `Can’t add suggestions: “${name}” is locked` : reason === 'hidden' ? `Can’t add suggestions: “${name}” is hidden` : 'The target group no longer exists',
          detail: reason === 'locked' ? 'Unlock the group, then accept again.' : reason === 'hidden' ? 'Show the group so you can see what is added, then accept again.' : 'Run Find similar again for another group.',
          action:
            group && reason === 'locked'
              ? { label: 'Unlock', run: () => groups.setLocked(group.id, false) }
              : group && reason === 'hidden'
                ? { label: 'Show group', run: () => groups.setHidden(group.id, false) }
                : undefined,
        })
        return false
      }
      const runId = newId()
      const plan = planAccept(l, v, scope, { annotations: annotations.current(), image, runId, at: now(), newId })
      if (!plan) {
        notify({ tone: 'info', key: 'assist', message: 'Nothing to accept here', detail: 'Every suggestion in this selection is already marked or rejected.' })
        return false
      }
      const n = plan.annotations.length
      // One batch: the reject-run sync sees the accept run and its recorded negatives together.
      const blocked = batch(() => {
        const b = annotations.applyBatch(image.id, plan.ops, { label: `Accept ${n} suggestion${n === 1 ? '' : 's'}`, detectionRun: plan.run })
        if (!b) setStore((st) => updateLayer(st, image.id, (x) => noteAccepted(x, runId, plan.negativeIndices)))
        return b
      })
      if (blocked) {
        notify({ tone: 'warning', key: 'assist', message: 'Couldn’t add the suggestions', detail: blocked.reason === 'invalid' ? blocked.detail : 'The target group can’t be edited right now.' })
        return false
      }
      const imageId = image.id
      notify({
        tone: 'success',
        key: 'assist-accept',
        message: `Added ${n.toLocaleString()} ${n === 1 ? 'colony' : 'colonies'} to “${group.name}”`,
        detail: plan.duplicates ? `${plan.duplicates} skipped: already marked.` : undefined,
        action: {
          label: 'Undo',
          run: () => {
            const last = state.history[imageId]?.undo.at(-1)
            if (state.currentImageId === imageId && last?.detectionRun?.runId === runId) annotations.undo()
            else notify({ tone: 'info', key: 'assist', message: 'Use Undo in the toolbar', detail: 'Other changes were made after this accept.' })
          },
        },
      })
      return true
    }

    // ------------------------------------------------------------ lifecycle
    // Another image: stop the run, free the worker's cached planes (iPad memory), keep layers.
    createEffect(
      on(
        () => state.currentImageId,
        () => {
          clearTimeout(timer)
          timer = undefined
          if (abort) {
            abort.abort()
            abort = null
            token++
          }
          client?.clearCache()
          const l = untrack(layer)
          batch(() => {
            setProgress(null)
            setError(null)
            setPhase(l ? 'ready' : 'idle')
            if (l) setSettingsSignal(l.settings)
          })
        },
        { defer: true },
      ),
    )
    // Rejections without an accept are recorded as the layer's reject-only run.
    createEffect(() => {
      const l = layer()
      const v = view()
      if (!l || !v) return
      void state.docs[l.imageId]?.detectionRuns // re-check when runs change (undo/redo of an accept)
      untrack(() => syncRejectRun(l, v))
    })
    // Another project (or the same one reloaded, e.g. the Drive version taken): discard every layer and close the panel.
    createEffect(
      on(
        () => [state.project?.id, state.loadCount],
        () => {
          cancel()
          client?.clearCache()
          batch(() => {
            setStore(emptyStore())
            setExplicitSource(new Map())
            setOpenSignal(false)
            setPhase('idle')
            setError(null)
          })
        },
        { defer: true },
      ),
    )
    // Drop layers whose image vanished, changed bytes or lost its target group.
    // Storage merges image records with reconcile (same array, fields updated in
    // place), so track the fields themselves, not just the array identity.
    createEffect(
      on(
        () => [(state.project?.images ?? []).map((i) => ({ id: i.id, fingerprint: i.fingerprint, sourceMismatch: i.sourceMismatch, deletedAt: i.deletedAt })), groups.list()] as const,
        ([imgs, list]) => {
          const pruned = pruneStore(untrack(store), imgs, list.map((g) => g.id))
          if (pruned === untrack(store)) return
          batch(() => {
            setStore(pruned)
            if (!untrack(layer) && untrack(phase) === 'ready') setPhase('idle')
          })
        },
        { defer: true },
      ),
    )

    return {
      open,
      setOpen,
      start,
      block,
      localSeeds,
      candidates,
      seedSource,
      setSeedSource(source) {
        const id = state.currentImageId
        if (!id) return
        setExplicitSource((m) => new Map(m).set(id, source))
      },
      phase,
      progress,
      error,
      layer,
      view,
      targetGroup,
      settings,
      setSettings,
      run: () => void runNow(),
      cancel,
      toggleReject,
      accept,
      rejectAll,
      restoreAll,
      setSizeMismatch,
      dispose() {
        cancel()
        client?.dispose()
        client = null
        disposeRoot()
      },
    }
  })
}

/** Human label of a progress stage. */
export function stageLabel(p: DetectProgress | null): string {
  switch (p?.stage) {
    case 'prepare':
      return 'Reading the image…'
    case 'roi':
      return 'Finding the plate…'
    case 'calibrate':
      return 'Measuring your examples…'
    case 'mask':
    case 'candidates':
      return 'Looking for colonies…'
    case 'fit':
      return 'Separating touching colonies…'
    case 'done':
      return 'Finishing…'
    default:
      return 'Starting…'
  }
}
