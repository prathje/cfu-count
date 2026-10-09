import { For, Show } from 'solid-js'
import type { AnnotationGroup } from '../../model/types'
import { LABEL_SIZE_RANGE, type GroupStylePatch } from '../../model/groups'
import { GROUP_PALETTE, colorName } from '../../model/palette'
import { Circle, CircleFilled, Lock, LockOpen } from '../icons'
import { Button, SegmentedControl, Slider, Switch } from '../primitives'
import { GroupSwatch } from '../shared/GroupSwatch'

/** Per-group appearance controls. Disabled with an explanation while the group is locked. */
export interface StylePanelProps {
  group: AnnotationGroup
  onChange(patch: GroupStylePatch): void
  onUnlock(): void
}

export function StylePanel(props: StylePanelProps) {
  const locked = () => props.group.locked
  const isCustom = () => !GROUP_PALETTE.some((c) => c.value === props.group.color.toLowerCase())
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
              { value: 'dot', label: 'Filled dot', icon: CircleFilled },
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
          format={(v) => `${v} px radius · on screen`}
          onInput={(size) => props.onChange({ size })}
        />
        <p class="field__hint">Stays the same size while you zoom in (slightly smaller when far zoomed out). A display size, not a measured colony size.</p>

        <div class="field-block">
          <div class="field-block__head">
            <span class="field__label" id="colour-label">
              Colour
            </span>
            <span class="field-block__value">{colorName(props.group.color)}</span>
          </div>
          <div class="color-grid" role="radiogroup" aria-labelledby="colour-label">
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
            <label
              class="color-chip color-chip--custom"
              classList={{ 'is-disabled': locked(), 'is-checked': isCustom() }}
              title="Custom colour"
              style={{ '--chip': isCustom() ? props.group.color : '#ffffff' }}
            >
              <input
                type="color"
                class="sr-only"
                role="radio"
                aria-checked={isCustom()}
                value={props.group.color}
                disabled={locked()}
                aria-label="Custom colour"
                onInput={(e) => props.onChange({ color: e.currentTarget.value })}
              />
            </label>
          </div>
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
          format={(v) => (props.group.labels ? `${v} px text` : 'Off')}
          onInput={(labelSize) => props.onChange({ labelSize })}
        />
        <Show when={!props.group.labels && !locked()}>
          <p class="field__hint">Turn on Labels to set the number size.</p>
        </Show>
      </fieldset>
    </div>
  )
}
