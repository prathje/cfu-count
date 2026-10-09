import { Show } from 'solid-js'
import type { RegionShape } from '../../model/region'
import type { CompareSeedMode } from '../../state/region'
import { AlertTriangle, Download, Eraser, Eye, EyeOff, GitCompare, Lasso, Loader, Sparkles, SquareDashed, X } from '../icons'
import { Button, IconButton, SegmentedControl } from '../primitives'
import { GroupSwatch } from '../shared/GroupSwatch'
import { plural } from '../format'
import './region-bar.css'

/** What the comparison shows (numbers only; the overlay is drawn by the viewport). */
export interface RegionCompareView {
  manual: number
  detected: number
  matched: number
  missed: number
  extra: number
  precision: number
  recall: number
  examples: number
  examplesMode: CompareSeedMode
  stale: boolean
  visible: boolean
}

export interface RegionBarProps {
  /** Phone layout: bottom sheet. */
  sheet: boolean
  /** The Region tool is selected (dragging draws). */
  drawing: boolean
  shape: RegionShape
  onShape(shape: RegionShape): void
  coarse: boolean
  /** Active group (counts and actions refer to it). */
  group: { name: string; color: string; render: 'dot' | 'circle' } | null
  /** Counts inside the region; null = no region yet. */
  tally: { group: number; all: number; clearable: number } | null
  /** Why Clear is refused right now (locked/hidden group), shown on the button's hint. */
  editBlocked: string | null
  onClear(): void
  onFindSimilar(): void
  onRedraw(): void
  onClose(): void
  compare: {
    running: boolean
    progress: { label: string; fraction: number } | null
    error: string | null
    /** Manual marks of the group inside / outside the region. */
    counts: { inside: number; outside: number }
    seedMode: CompareSeedMode
    onSeedMode(mode: CompareSeedMode): void
    result: RegionCompareView | null
    onRun(): void
    onCancel(): void
    onToggleVisible(): void
    onExport(): void
  }
  ref?(el: HTMLElement): void
}

const pct = (v: number) => `${Math.round(v * 100)} %`

/**
 * Floating region bar (bottom sheet on phones): counts inside the selected
 * region and what to do with it. Presentational: data in, callbacks out.
 */
export function RegionBar(props: RegionBarProps) {
  const c = () => props.compare
  const canCompare = () => (c().seedMode === 'inside' ? c().counts.inside >= 4 : c().counts.outside >= 3 && c().counts.inside > 0)
  return (
    <section
      ref={(el) => props.ref?.(el)}
      class="region-bar"
      classList={{ 'region-bar--sheet': props.sheet }}
      role="region"
      aria-label="Selected region"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <header class="region-bar__head">
        <Lasso size={17} aria-hidden="true" class="region-bar__icon" />
        <h2 class="region-bar__title">Region</h2>
        <SegmentedControl<RegionShape>
          label="Region shape"
          value={props.shape}
          options={[
            { value: 'lasso', label: 'Lasso', icon: Lasso },
            { value: 'rect', label: 'Rectangle', icon: SquareDashed },
          ]}
          onChange={(v) => props.onShape(v)}
        />
        <IconButton icon={X} label="Close region" size="sm" onClick={() => props.onClose()} />
      </header>

      <Show
        when={props.tally}
        fallback={
          <p class="region-bar__hint" role="status">
            {props.coarse ? 'Drag one finger or the Pencil around the colonies.' : 'Drag around the colonies to select them.'}{' '}
            {props.shape === 'rect' ? 'Drag a rectangle.' : props.coarse ? '' : 'Hold Shift for a rectangle.'}{' '}
            {props.coarse ? 'Two fingers pan and zoom.' : 'Esc cancels.'}
          </p>
        }
      >
        {(t) => (
          <>
            <p class="region-bar__count" role="status" aria-live="polite">
              <Show when={props.group} fallback={<span>No group selected</span>}>
                {(g) => (
                  <span>
                    <strong class="region-bar__num">{t().group.toLocaleString()}</strong> in <GroupSwatch color={g().color} render={g().render} size={10} /> “{g().name}”
                  </span>
                )}
              </Show>
              <span class="region-bar__sep" aria-hidden="true">
                ·
              </span>
              <span>{t().all.toLocaleString()} total</span>
            </p>
            <div class="region-bar__actions">
              <Button
                size="sm"
                variant="ghost"
                icon={Eraser}
                class="region-bar__clear"
                aria-disabled={props.editBlocked || t().clearable === 0 ? true : undefined}
                onClick={() => props.onClear()}
              >
                Clear {t().clearable.toLocaleString()}
              </Button>
              <Button size="sm" variant="ghost" icon={Sparkles} onClick={() => props.onFindSimilar()}>
                Find similar
              </Button>
              <Button
                size="sm"
                variant={c().result ? 'ghost' : 'subtle'}
                icon={GitCompare}
                disabled={c().running}
                aria-disabled={!canCompare() ? true : undefined}
                onClick={() => c().onRun()}
              >
                Compare
              </Button>
            </div>
            <Show when={props.editBlocked}>{(b) => <p class="region-bar__hint">{b()}: clearing is unavailable.</p>}</Show>
            <Show when={c().counts.outside >= 3 && (c().counts.inside >= 1 || c().seedMode === 'outside')}>
              <div class="region-bar__row">
                <span class="region-bar__label">Examples</span>
                <SegmentedControl<CompareSeedMode>
                  label="Examples for the comparison"
                  value={c().seedMode}
                  disabled={c().running}
                  options={[
                    { value: 'inside', label: `${Math.min(8, Math.max(3, Math.floor(c().counts.inside / 2)))} from region` },
                    { value: 'outside', label: `${Math.min(40, c().counts.outside)} outside` },
                  ]}
                  onChange={(v) => c().onSeedMode(v)}
                />
              </div>
            </Show>
          </>
        )}
      </Show>

      <Show when={c().running}>
        <div class="region-bar__progress" role="status" aria-live="polite">
          <Loader size={15} class="spin" aria-hidden="true" />
          <span>{c().progress?.label ?? 'Starting…'}</span>
          <div class="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((c().progress?.fraction ?? 0) * 100)}>
            <div class="progress__bar" style={{ width: `${Math.round((c().progress?.fraction ?? 0) * 100)}%` }} />
          </div>
          <Button size="sm" onClick={() => c().onCancel()}>
            Cancel
          </Button>
        </div>
      </Show>
      <Show when={c().error}>
        {(e) => (
          <div class="region-bar__notice" role="alert">
            <AlertTriangle size={15} aria-hidden="true" /> {e()}
          </div>
        )}
      </Show>

      <Show when={!c().running && c().result}>
        {(r) => (
          <div class="region-bar__compare" classList={{ 'is-stale': r().stale }}>
            <dl class="region-bar__stats" aria-label="Comparison with the detector">
              <div>
                <dt>Manual</dt>
                <dd>{r().manual}</dd>
              </div>
              <div>
                <dt>Detected</dt>
                <dd>{r().detected}</dd>
              </div>
              <div>
                <dt>Matched</dt>
                <dd>{r().matched}</dd>
              </div>
              <div>
                <dt>
                  <span class="region-bar__key region-bar__key--missed" aria-hidden="true" />
                  Missed
                </dt>
                <dd>{r().missed}</dd>
              </div>
              <div>
                <dt>
                  <span class="region-bar__key region-bar__key--extra" aria-hidden="true" />
                  Extra
                </dt>
                <dd>{r().extra}</dd>
              </div>
            </dl>
            <p class="region-bar__note">
              Recall {pct(r().recall)} · precision {pct(r().precision)}. {plural(r().examples, 'example', 'examples')} {r().examplesMode === 'inside' ? 'from the region' : 'from outside'} not scored.
              <Show when={r().stale}>
                {' '}
                <strong>Marks or region changed since: run again.</strong>
              </Show>
            </p>
            <div class="region-bar__actions">
              <Button size="sm" variant="ghost" icon={r().visible ? EyeOff : Eye} aria-pressed={r().visible} onClick={() => c().onToggleVisible()}>
                {r().visible ? 'Hide marks' : 'Show marks'}
              </Button>
              <Button size="sm" variant="ghost" icon={Download} onClick={() => c().onExport()}>
                Export comparison
              </Button>
            </div>
          </div>
        )}
      </Show>

      <Show when={props.tally && !props.drawing}>
        <button type="button" class="region-bar__link" onClick={() => props.onRedraw()}>
          Redraw region
        </button>
      </Show>
    </section>
  )
}
