import { For, Show } from 'solid-js'
import type { AnnotationGroup } from '../../model/types'
import { LABEL_SIZE_RANGE, type GroupStylePatch } from '../../state/core'
import { GROUP_PALETTE, colorName } from '../../state/palette'
import { Circle, CircleDot, Lock, LockOpen } from '../icons'
import { Button, SegmentedControl, Slider, Switch } from '../primitives'
import { GroupSwatch } from './GroupSwatch'

/** Per-group appearance controls. Disabled with an explanation while the group is locked. */
export interface StylePanelProps {
  group: AnnotationGroup
  onChange(patch: GroupStylePatch): void
  onUnlock(): void
}

export function StylePanel(props: StylePanelProps) {
  const locked = () => props.group.locked
  return (
    <div class="style-panel">
      <div class="style-panel__head">
        <GroupSwatch color={props.group.color} render={props.group.render} size={18} />
        <div>
          <div class="pop-title">{props.group.name}</div>
          <div class="pop-subtitle">Appearance only — positions and counts don’t change</div>
        </div>
      </div>

      <Show when={locked()}>
        <div class="notice notice--locked" role="note">
          <Lock size={16} aria-hidden="true" />
          <span>This group is locked. Unlock it to change its appearance.</span>
          <Button size="sm" variant="subtle" icon={LockOpen} onClick={() => props.onUnlock()}>
            Unlock to edit
          </Button>
        </div>
      </Show>

      <fieldset class="style-panel__fields" disabled={locked()}>
        <div class="field-block">
          <span class="field__label" id="render-label">
            Marker
          </span>
          <SegmentedControl
            label="Marker shape"
            value={props.group.render}
            disabled={locked()}
            options={[
              { value: 'dot', label: 'Filled dot', icon: CircleDot },
              { value: 'circle', label: 'Circle outline', icon: Circle },
            ]}
            onChange={(render) => props.onChange({ render })}
          />
        </div>

        <Slider
          label="Opacity"
          value={Math.round(props.group.opacity * 100)}
          min={10}
          max={100}
          step={5}
          disabled={locked()}
          format={(v) => `${v} %`}
          onInput={(v) => props.onChange({ opacity: v / 100 })}
        />

        <Slider
          label="Marker size"
          value={props.group.size}
          min={2}
          max={24}
          disabled={locked()}
          format={(v) => `${v} px on screen`}
          onInput={(size) => props.onChange({ size })}
        />
        <p class="field__hint">Display size stays constant while zooming. It is not a measured colony size.</p>

        <div class="field-block">
          <span class="field__label">Colour</span>
          <div class="color-grid" role="radiogroup" aria-label="Group colour">
            <For each={GROUP_PALETTE}>
              {(c) => (
                <button
                  type="button"
                  role="radio"
                  class="color-chip"
                  aria-checked={props.group.color.toLowerCase() === c.value}
                  aria-label={c.name}
                  title={c.name}
                  disabled={locked()}
                  style={{ '--chip': c.value }}
                  onClick={() => props.onChange({ color: c.value })}
                />
              )}
            </For>
            <label class="color-custom" title="Custom colour">
              <input
                type="color"
                value={props.group.color}
                disabled={locked()}
                aria-label="Custom colour"
                onInput={(e) => props.onChange({ color: e.currentTarget.value })}
              />
              <span>Custom</span>
            </label>
          </div>
          <span class="field__hint">{colorName(props.group.color)}</span>
        </div>

        <Switch
          label="Labels"
          description="Number markers on the image"
          checked={props.group.labels}
          disabled={locked()}
          onChange={(labels) => props.onChange({ labels })}
        />
        <Slider
          label="Label size"
          value={props.group.labelSize}
          min={LABEL_SIZE_RANGE.min}
          max={LABEL_SIZE_RANGE.max}
          disabled={locked() || !props.group.labels}
          format={(v) => `${v} px`}
          onInput={(labelSize) => props.onChange({ labelSize })}
        />
        <Show when={!props.group.labels && !locked()}>
          <p class="field__hint">Turn labels on to use the label size.</p>
        </Show>
      </fieldset>
    </div>
  )
}
