import { For, Show } from 'solid-js'
import type { Cue } from '../../state/feedback'
import type { CueToggle, SoundSettings, SoundSettingsPatch } from '../../state/soundSettings'
import { Keyboard, Settings, Volume2 } from '../icons'
import ExternalLink from 'lucide-solid/icons/external-link'
import ScrollText from 'lucide-solid/icons/scroll-text'
import { LICENSE_URL, REPO_URL } from '../about/terms'
import { IconButton, MenuItem, MenuSection, Popover, Slider, Switch, createPopoverState } from '../primitives'

/** Device settings popover (app bar gear): sound feedback, touch input, shortcuts. */
export interface SettingsMenuProps {
  sound: SoundSettings
  onSound(patch: SoundSettingsPatch): void
  /** Play a cue now (Test buttons, switching a cue on). */
  onPreview(cue: Cue): void
  /** This browser has no Web Audio. */
  audioUnavailable: boolean
  /** Show the Silent-mode note (iPhone / iPad). */
  appleTouch: boolean
  /** Show the touch-annotates switch (devices with a touch screen). */
  showTouch: boolean
  touchAnnotates: boolean
  onTouchAnnotates(on: boolean): void
  onShowShortcuts(): void
  /** Re-open the terms of use. */
  onShowTerms(): void
}

interface CueRow {
  key: CueToggle
  label: string
  description: string
  preview: Cue
}

export const CUE_ROWS: readonly CueRow[] = [
  { key: 'place', label: 'Placing', description: 'Soft tick; double tick on top of another marker', preview: 'add' },
  { key: 'erase', label: 'Erasing', description: 'Lower, softer tick', preview: 'erase' },
  { key: 'error', label: 'Errors', description: 'Blocked edits and failed actions', preview: 'error' },
  { key: 'accept', label: 'Assisted accept', description: 'Chime when suggestions are added', preview: 'accept' },
  { key: 'undo', label: 'Undo and redo', description: 'Short blip', preview: 'undo' },
]

export function SettingsMenu(props: SettingsMenuProps) {
  const pop = createPopoverState()
  const soundOff = () => !props.sound.enabled || props.audioUnavailable
  return (
    <>
      <IconButton
        ref={pop.setAnchor}
        icon={Settings}
        label="Settings"
        hint="Sound feedback and device preferences"
        class={pop.open() ? 'is-open' : ''}
        aria-haspopup="dialog"
        aria-expanded={pop.open()}
        onClick={pop.toggle}
      />
      <Popover open={pop.open()} anchor={pop.anchor()} onClose={pop.close} label="Settings" width={330} placement="bottom-end" class="settings-pop">
        <div class="pop-header">
          <span class="pop-title">Settings</span>
          <span class="pop-subtitle">Saved in this browser on this device</span>
        </div>

        <MenuSection title="Sound feedback">
          <div class="settings-pop__body">
            <Switch
              label="Sound feedback"
              description={props.audioUnavailable ? 'This browser can’t play sounds' : 'Short cues so you hear whether a tap worked'}
              checked={props.sound.enabled && !props.audioUnavailable}
              disabled={props.audioUnavailable}
              onChange={(on) => {
                props.onSound({ enabled: on })
                if (on) props.onPreview('add')
              }}
            />
            <Slider
              label="Volume"
              value={Math.round(props.sound.volume * 100)}
              min={0}
              max={100}
              step={5}
              format={(v) => `${v} %`}
              disabled={soundOff()}
              onInput={(v) => props.onSound({ volume: v / 100 })}
            />
            <div class="settings-cues" role="group" aria-label="Sounds">
              <For each={CUE_ROWS}>
                {(row) => (
                  <div class="settings-cue">
                    <Switch
                      label={row.label}
                      description={row.description}
                      checked={props.sound.cues[row.key]}
                      disabled={soundOff()}
                      onChange={(on) => {
                        props.onSound({ cues: { [row.key]: on } })
                        if (on) props.onPreview(row.preview)
                      }}
                    />
                    <IconButton
                      icon={Volume2}
                      size="sm"
                      label={`Test ${row.label.toLowerCase()} sound`}
                      disabled={soundOff()}
                      onClick={() => props.onPreview(row.preview)}
                    />
                  </div>
                )}
              </For>
            </div>
            <Show when={props.appleTouch && !props.audioUnavailable}>
              <p class="settings-pop__note">On iPad and iPhone, Silent mode (the switch or Control Center) also mutes these sounds.</p>
            </Show>
          </div>
        </MenuSection>

        <Show when={props.showTouch}>
          <MenuSection title="Touch">
            <div class="settings-pop__body">
              <Switch
                label="Touch annotates"
                description={props.touchAnnotates ? 'One-finger taps add or erase markers' : 'Fingers only pan and zoom; Apple Pencil annotates'}
                checked={props.touchAnnotates}
                onChange={props.onTouchAnnotates}
              />
            </div>
          </MenuSection>
        </Show>

        <MenuSection>
          <MenuItem
            icon={Keyboard}
            label="Keyboard shortcuts"
            trailing={<kbd>?</kbd>}
            onClick={() => {
              pop.close()
              props.onShowShortcuts()
            }}
          />
        </MenuSection>

        <MenuSection>
          <MenuItem
            icon={ExternalLink}
            label="Source code on GitHub"
            description="prathje/cfu-count"
            onClick={() => {
              pop.close()
              window.open(REPO_URL, '_blank', 'noopener,noreferrer')
            }}
          />
          <MenuItem
            icon={ScrollText}
            label="Terms of use"
            description="Provided as is · MIT License"
            onClick={() => {
              pop.close()
              props.onShowTerms()
            }}
          />
          <MenuItem
            icon={ExternalLink}
            label="MIT License"
            onClick={() => {
              pop.close()
              window.open(LICENSE_URL, '_blank', 'noopener,noreferrer')
            }}
          />
        </MenuSection>
      </Popover>
    </>
  )
}
