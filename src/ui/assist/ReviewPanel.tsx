import { For, Show } from 'solid-js'
import type { DetectMethod } from '../../detection/types'
import type { ReviewSettings, ReferenceCandidate, SeedSource, ReviewCluster } from '../../state/assist'
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Loader, Sparkles, X } from '../icons'
import { Button, IconButton, SegmentedControl, Slider } from '../primitives'
import { GroupSwatch } from '../shared/GroupSwatch'
import { plural } from '../format'
import './review-panel.css'

/** Plain-language results of one run, for the panel. */
export interface ReviewSummary {
  suggested: number
  needReview: number
  rejected: number
  okCount: number
  tooLarge: number
  calibration: { summary: string; warnings: readonly string[]; tentative: boolean }
  /** Rim band excluded from the search, in image px. */
  rimPx: number
  elapsedMs: number
  /** Time spent in the detector itself (worker), in ms. */
  detectorMs: number | null
  /** Reference image the examples came from, if any. */
  referenceName: string | null
}

export interface ReviewPanelProps {
  /** Phone layout: bottom sheet. */
  sheet: boolean
  group: { name: string; color: string; render: 'dot' | 'circle' } | null
  /** Why Find similar is unavailable, with an optional fix. */
  block: { message: string; detail: string; fix?: { label: string; run(): void } } | null
  phase: 'idle' | 'running' | 'ready' | 'error'
  progress: { label: string; fraction: number } | null
  error: string | null
  localSeeds: number
  minSeeds: number
  candidates: readonly ReferenceCandidate[]
  seedSource: SeedSource
  onSeedSource(source: SeedSource): void
  summary: ReviewSummary | null
  settings: ReviewSettings
  onSettings(patch: Partial<ReviewSettings>): void
  /** Review navigator: current cluster (1-based position) or null when nothing needs review. */
  review: { position: number; total: number; cluster: ReviewCluster } | null
  onPrevReview(): void
  onNextReview(): void
  onAcceptPrimary(): void
  onAcceptAlternative(): void
  onAcceptOk(): void
  onRejectAll(): void
  onRun(): void
  onCancel(): void
  onClose(): void
  ref?(el: HTMLElement): void
}

const METHODS: { value: DetectMethod; label: string }[] = [
  { value: 'fitter', label: 'Fitter' },
  { value: 'watershed', label: 'Watershed' },
  { value: 'log', label: 'Blob' },
]

const sensitivityText = (v: number) => (v < 0.35 ? 'Fewer' : v > 0.65 ? 'More' : 'Balanced') + ` (${Math.round(v * 100)} %)`
const toleranceText = (v: number) => (v < 0.85 ? 'Strict' : v > 1.25 ? 'Loose' : 'Normal') + ` (×${v.toFixed(2)})`
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`

/**
 * The assisted-counting review panel: a dismissible floating card (bottom sheet
 * on phones), never a permanent sidebar. Presentational: data in, callbacks out.
 */
export function ReviewPanel(props: ReviewPanelProps) {
  const sourceValue = () => (props.seedSource.kind === 'this-image' ? 'this' : props.seedSource.imageId)
  const ready = () => props.phase === 'ready' && props.summary

  return (
    <section
      ref={(el) => props.ref?.(el)}
      class="review-panel"
      classList={{ 'review-panel--sheet': props.sheet }}
      role="dialog"
      aria-modal="false"
      aria-labelledby="review-panel-title"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <header class="review-panel__head">
        <Sparkles size={17} aria-hidden="true" class="review-panel__icon" />
        <h2 id="review-panel-title" class="review-panel__title">
          Assisted counting <span class="beta">beta</span>
        </h2>
        <IconButton icon={X} label="Close assisted counting" size="sm" onClick={() => props.onClose()} />
      </header>

      <p class="review-panel__intro">
        Finds colonies that look like your examples
        <Show when={props.group}>
          {(g) => (
            <>
              {' '}in <GroupSwatch color={g().color} render={g().render} size={10} /> <strong>{g().name}</strong>
            </>
          )}
        </Show>
        . Suggestions are <strong>not counted</strong> until you review and accept them.
      </p>

      <Show when={props.block}>
        {(b) => (
          <div class="review-panel__notice review-panel__notice--warn" role="status">
            <AlertTriangle size={16} aria-hidden="true" />
            <div>
              <strong>{b().message}</strong>
              <div>{b().detail}</div>
            </div>
            <Show when={b().fix}>{(fix) => <Button size="sm" onClick={() => fix().run()}>{fix().label}</Button>}</Show>
          </div>
        )}
      </Show>

      <Show when={!props.block || props.summary}>
        {/* Examples (seeds) */}
        <div class="review-panel__row">
          <label class="review-panel__label" for="review-seeds">
            Examples
          </label>
          <Show
            when={props.candidates.length > 0}
            fallback={<span class="review-panel__value">{plural(props.localSeeds, 'colony', 'colonies')} marked on this image</span>}
          >
            <select
              id="review-seeds"
              class="review-panel__select"
              value={sourceValue()}
              disabled={props.phase === 'running'}
              onChange={(e) => {
                const v = e.currentTarget.value
                props.onSeedSource(v === 'this' ? { kind: 'this-image' } : { kind: 'reference', imageId: v })
              }}
            >
              <option value="this" disabled={props.localSeeds === 0}>
                This image ({props.localSeeds})
              </option>
              <For each={props.candidates}>{(c) => <option value={c.imageId}>{`${c.name} (${c.count})${props.localSeeds ? ' + this image' : ''}`}</option>}</For>
            </select>
          </Show>
        </div>
        <Show when={props.seedSource.kind === 'this-image' && props.localSeeds < props.minSeeds}>
          <p class="review-panel__hint">
            {props.localSeeds === 0
              ? `Mark ${props.minSeeds} or more typical colonies by hand first`
              : `Only ${plural(props.localSeeds, 'example', 'examples')}: results will be tentative. Mark ${props.minSeeds - props.localSeeds} more`}
            {props.candidates.length > 0 ? ', or borrow examples from another image above.' : '.'}
          </p>
        </Show>
        <Show when={props.seedSource.kind === 'reference'}>
          <p class="review-panel__hint">Examples from another plate assume the same camera, distance and lighting.</p>
        </Show>

        {/* Running */}
        <Show when={props.phase === 'running'}>
          <div class="review-panel__progress" role="status" aria-live="polite">
            <div class="review-panel__progress-label">
              <Loader size={15} class="spin" aria-hidden="true" /> {props.progress?.label ?? 'Starting…'}
            </div>
            <div class="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((props.progress?.fraction ?? 0) * 100)}>
              <div class="progress__bar" style={{ width: `${Math.round((props.progress?.fraction ?? 0) * 100)}%` }} />
            </div>
            <Button size="sm" onClick={() => props.onCancel()}>
              Cancel
            </Button>
          </div>
        </Show>

        <Show when={props.phase === 'error'}>
          <div class="review-panel__notice review-panel__notice--error" role="alert">
            <AlertTriangle size={16} aria-hidden="true" />
            <div>{props.error}</div>
          </div>
        </Show>

        <Show when={props.phase === 'idle' || props.phase === 'error'}>
          <Button variant="primary" icon={Sparkles} class="review-panel__run" onClick={() => props.onRun()}>
            {props.phase === 'error' ? 'Try again' : 'Find similar colonies'}
          </Button>
        </Show>

        {/* Results */}
        <Show when={ready()}>
          {(sum) => (
            <>
              <div class="review-counts" aria-label="Suggestions, not counted">
                <span class="review-counts__main">
                  <strong>{sum().suggested.toLocaleString()}</strong> suggested
                </span>
                <span class="review-counts__item" classList={{ 'is-warn': sum().needReview > 0 }}>
                  {sum().needReview.toLocaleString()} need review
                </span>
                <span class="review-counts__item">{sum().rejected.toLocaleString()} rejected</span>
                <span class="review-counts__note">not counted yet</span>
              </div>

              <details class="review-panel__calibration">
                <summary>
                  {sum().calibration.summary}
                  <Show when={sum().referenceName}>{(n) => <> (from {n()})</>}</Show>
                  <Show when={sum().calibration.warnings.length}>
                    {' '}· <span class="is-warn">{plural(sum().calibration.warnings.length, 'note', 'notes')}</span>
                  </Show>
                </summary>
                <ul>
                  <Show when={sum().calibration.tentative}>
                    <li>Results are tentative: check them carefully.</li>
                  </Show>
                  <For each={sum().calibration.warnings}>{(w) => <li>{w}</li>}</For>
                  <li>
                    A band of about {Math.round(sum().rimPx)} px along the plate wall is not searched. Mark colonies there by hand.
                  </li>
                  <Show when={sum().tooLarge > 0}>
                    <li>{plural(sum().tooLarge, 'area is', 'areas are')} too dense to separate (red outline): count by hand.</li>
                  </Show>
                  <li>
                    Analysed in {seconds(sum().elapsedMs)} on this device
                    <Show when={sum().detectorMs != null}>{` (detector ${seconds(sum().detectorMs!)})`}</Show>.
                  </li>
                </ul>
              </details>

              <Show when={props.review}>
                {(r) => (
                  <div class="review-nav" role="group" aria-label="Regions that need review">
                    <div class="review-nav__head">
                      <IconButton icon={ChevronLeft} label="Previous region" size="sm" onClick={() => props.onPrevReview()} />
                      <span class="review-nav__label">
                        Needs review {r().position} of {r().total}: <strong>{r().cluster.question}</strong>
                      </span>
                      <IconButton icon={ChevronRight} label="Next region" size="sm" onClick={() => props.onNextReview()} />
                    </div>
                    <div class="review-nav__actions">
                      <Show when={r().cluster.primary.length > 0}>
                        <Button size="sm" icon={Check} onClick={() => props.onAcceptPrimary()}>
                          {`Accept ${r().cluster.primary.length}`}
                        </Button>
                      </Show>
                      <Show when={r().cluster.alternative}>
                        {(alt) => (
                          <Button size="sm" icon={Check} onClick={() => props.onAcceptAlternative()}>
                            {r().cluster.primary.length > 0 ? `Accept ${alt().colonies.length} instead` : `Add ${alt().colonies.length}`}
                          </Button>
                        )}
                      </Show>
                      <Button size="sm" variant="ghost" onClick={() => props.onNextReview()}>
                        Skip
                      </Button>
                    </div>
                    <Show when={r().cluster.alternative}>
                      <p class="review-nav__legend">Dashed rings: the suggestion · dotted amber rings: the alternative.</p>
                    </Show>
                  </div>
                )}
              </Show>

              <details class="review-panel__settings" open={!props.sheet}>
                <summary>Adjust search</summary>
                <div class="review-panel__fields">
                  <SegmentedControl label="Method" value={props.settings.method} options={METHODS} onChange={(method) => props.onSettings({ method })} />
                  <Slider label="Sensitivity" value={props.settings.sensitivity} min={0} max={1} step={0.05} format={sensitivityText} onInput={(sensitivity) => props.onSettings({ sensitivity })} />
                  <Slider label="Size tolerance" value={props.settings.priorWidth} min={0.5} max={2} step={0.05} format={toleranceText} onInput={(priorWidth) => props.onSettings({ priorWidth })} />
                </div>
              </details>

              <p class="review-panel__hint">Tap a dashed ring to reject it; tap again to restore it.</p>

              <div class="review-panel__actions">
                <Button variant="primary" icon={Check} disabled={sum().okCount === 0} onClick={() => props.onAcceptOk()}>
                  {`Accept ${sum().okCount.toLocaleString()} OK`}
                </Button>
                <Button variant="ghost" onClick={() => props.onRejectAll()}>
                  Reject all
                </Button>
              </div>
              <Show when={sum().needReview > 0 && sum().okCount > 0}>
                <p class="review-panel__hint review-panel__hint--small">“Accept OK” leaves the {plural(sum().needReview, 'suggestion', 'suggestions')} that need review pending.</p>
              </Show>
            </>
          )}
        </Show>
      </Show>
    </section>
  )
}
