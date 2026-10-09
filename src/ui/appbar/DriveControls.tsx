import { Match, Show, Switch as SolidSwitch } from 'solid-js'
import type { ProjectStorageLink } from '../../model/types'
import type { DriveLinkMode, DriveState, SaveStatus } from '../../storage/api'
import { AlertTriangle, Check, Cloud, CloudAlert, CloudCheck, CloudOff, CloudUpload, FolderOpen, FolderPlus, HardDrive, Loader, LogOut, RefreshCw, type IconComponent } from '../icons'
import { Button, Popover, createPopoverState } from '../primitives'
import { driveLabel, saveStatusLabel, type StatusTone } from '../format'

/** Actions offered by the Drive panel. */
export interface DriveActions {
  onConnect(): void
  onDisconnect(): void
  onLink(mode: DriveLinkMode): void
  onOpenFromDrive(): void
  onSaveNow(): void
  onKeepMine(): void
  onTakeDrive(): void
}

/** Shared inputs of the save pill and Drive button. */
export interface SyncInfo {
  status: SaveStatus
  drive: DriveState
  /** Storage link of the open project (null if none open). */
  storage: ProjectStorageLink | null
  /** Unsaved edits waiting for the debounce. */
  dirty: boolean
}

const STATUS_ICON: Record<SaveStatus['state'], IconComponent> = {
  idle: HardDrive,
  'saved-local': HardDrive,
  'local-error': AlertTriangle,
  pending: CloudUpload,
  'saving-drive': Loader,
  'saved-drive': CloudCheck,
  'reconnect-required': CloudAlert,
  failed: CloudAlert,
  conflict: AlertTriangle,
}

/** Save status pill: always shows a distinct text label for every state. */
export function SaveStatusPill(props: SyncInfo & DriveActions & { compact: boolean }) {
  const pop = createPopoverState()
  const info = () => saveStatusLabel(props.status)
  const Icon = () => {
    const I = props.dirty && props.status.state !== 'saving-drive' ? Loader : STATUS_ICON[props.status.state]
    return <I size={15} stroke-width={2} aria-hidden="true" class={I === Loader ? 'spin' : ''} />
  }
  return (
    <Show when={props.status.state !== 'idle'}>
      <button
        ref={pop.setAnchor}
        type="button"
        class={`status-pill tone-${info().tone}`}
        classList={{ 'is-compact': props.compact }}
        aria-haspopup="dialog"
        aria-expanded={pop.open()}
        aria-label={`Save status: ${info().label}${props.dirty ? ', saving changes' : ''}. Details`}
        onClick={pop.toggle}
      >
        {Icon()}
        <span class="status-pill__label">{info().label}</span>
      </button>
      <div class="sr-only" role="status" aria-live="polite">
        {info().tone === 'error' || info().tone === 'warn' ? info().label : ''}
      </div>
      <Popover open={pop.open()} anchor={pop.anchor()} onClose={pop.close} label="Save status" width={340} placement="bottom-end">
        <DrivePanel {...props} onAction={pop.close} />
      </Popover>
    </Show>
  )
}

/** Google Drive button showing connection state, account and workspace folder. */
export function DriveButton(props: SyncInfo & DriveActions & { compact: boolean }) {
  const pop = createPopoverState()
  const folder = () => (props.storage?.kind === 'drive' ? props.storage.folderName : null)
  const icon = (): IconComponent => {
    switch (props.drive.state) {
      case 'unconfigured':
      case 'disconnected':
        return CloudOff
      case 'connecting':
        return Loader
      case 'expired':
        return CloudAlert
      case 'connected':
        return folder() ? CloudCheck : Cloud
    }
  }
  const label = () => (props.drive.state === 'connected' && folder() ? folder()! : driveLabel(props.drive))
  return (
    <>
      <button
        ref={pop.setAnchor}
        type="button"
        class="drive-btn"
        classList={{
          'is-compact': props.compact,
          'is-warn': props.drive.state === 'expired',
          'is-muted': props.drive.state === 'unconfigured',
          'is-connected': props.drive.state === 'connected',
        }}
        aria-haspopup="dialog"
        aria-expanded={pop.open()}
        aria-label={`Google Drive: ${driveLabel(props.drive)}${folder() ? `, folder ${folder()}` : ''}. Drive options`}
        onClick={pop.toggle}
      >
        {(() => {
          const I = icon()
          return <I size={17} stroke-width={1.9} aria-hidden="true" class={I === Loader ? 'spin' : ''} />
        })()}
        <span class="drive-btn__label">{label()}</span>
      </button>
      <Popover open={pop.open()} anchor={pop.anchor()} onClose={pop.close} label="Google Drive" width={340} placement="bottom-end">
        <DrivePanel {...props} onAction={pop.close} />
      </Popover>
    </>
  )
}

const TONE_ICON: Record<StatusTone, IconComponent> = {
  neutral: HardDrive,
  ok: Check,
  busy: Loader,
  warn: AlertTriangle,
  error: AlertTriangle,
}

/** Panel content shared by the status pill and the Drive button. */
function DrivePanel(props: SyncInfo & DriveActions & { onAction(): void }) {
  const info = () => saveStatusLabel(props.status)
  const linked = () => (props.storage?.kind === 'drive' ? props.storage : null)
  const act = (fn: () => void) => () => {
    props.onAction()
    fn()
  }
  const account = () =>
    props.drive.state === 'connected' || props.drive.state === 'expired' ? props.drive.account : undefined

  return (
    <div class="drive-panel">
      <Show when={props.status.state !== 'idle'}>
        <div class={`drive-panel__status tone-${info().tone}`}>
          {(() => {
            const I = TONE_ICON[info().tone]
            return <I size={16} aria-hidden="true" class={I === Loader ? 'spin' : ''} />
          })()}
          <div>
            <div class="drive-panel__status-label">{info().label}</div>
            <div class="drive-panel__status-detail">{info().detail}</div>
          </div>
        </div>
      </Show>

      <Show when={props.status.state === 'conflict' ? (props.status as { files: string[] }) : null}>
        {(c) => (
          <div class="conflict">
            <p>
              Someone (or another device) changed {c().files.length === 1 ? 'a file' : `${c().files.length} files`} in the Drive folder after this
              browser last read it. Choose which version to keep — the other is not lost.
            </p>
            <ul class="conflict__files">
              {c().files.slice(0, 4).map((f) => (
                <li>{f}</li>
              ))}
            </ul>
            <div class="conflict__actions">
              <Button variant="primary" onClick={act(props.onKeepMine)}>
                Keep mine
              </Button>
              <Button onClick={act(props.onTakeDrive)}>Take Drive version</Button>
            </div>
            <p class="field__hint">“Keep mine” overwrites the Drive copy. “Take Drive version” keeps your local copy as a separate backup project.</p>
          </div>
        )}
      </Show>

      <div class="drive-panel__section">
        <div class="section-label">Google Drive</div>
        <SolidSwitch>
          <Match when={props.drive.state === 'unconfigured'}>
            <p class="drive-panel__text">
              Google Drive isn’t set up for this copy of the app. It needs a Google OAuth client ID configured at build time (see the setup
              guide). Your work is saved in this browser and can be downloaded as a .zip.
            </p>
          </Match>
          <Match when={props.drive.state === 'disconnected'}>
            <p class="drive-panel__text">Connect your Google account to save this project to a Drive folder and open it on other devices.</p>
            <Button variant="primary" icon={Cloud} onClick={act(props.onConnect)}>
              Connect Google Drive
            </Button>
          </Match>
          <Match when={props.drive.state === 'connecting'}>
            <p class="drive-panel__text">
              <Loader size={14} class="spin" aria-hidden="true" /> Waiting for Google sign-in…
            </p>
          </Match>
          <Match when={props.drive.state === 'expired'}>
            <p class="drive-panel__text">
              Your Google session{account() ? ` for ${account()}` : ''} expired. Changes are kept in this browser until you reconnect.
            </p>
            <Button variant="primary" icon={RefreshCw} onClick={act(props.onConnect)}>
              Reconnect
            </Button>
          </Match>
          <Match when={props.drive.state === 'connected'}>
            <dl class="drive-facts">
              <dt>Account</dt>
              <dd>{account() ?? 'Connected'}</dd>
              <dt>Folder</dt>
              <dd>
                <Show when={linked()} fallback={<span class="muted">This project isn’t linked to Drive yet</span>}>
                  {(l) => (
                    <>
                      <FolderOpen size={14} aria-hidden="true" /> {l().folderName}
                    </>
                  )}
                </Show>
              </dd>
            </dl>
            <div class="drive-panel__actions">
              <Show
                when={linked()}
                fallback={
                  <Show when={props.storage}>
                    <Button variant="primary" icon={FolderPlus} onClick={act(() => props.onLink('create-folder'))}>
                      Save to a new Drive folder
                    </Button>
                    <Button icon={FolderOpen} onClick={act(() => props.onLink('pick-folder'))}>
                      Choose existing folder…
                    </Button>
                  </Show>
                }
              >
                <Button variant="primary" icon={CloudUpload} disabled={props.status.state === 'saving-drive'} onClick={act(props.onSaveNow)}>
                  Save to Drive now
                </Button>
              </Show>
              <Button variant="ghost" icon={FolderOpen} onClick={act(props.onOpenFromDrive)}>
                Open project from Drive…
              </Button>
              <Button variant="ghost" icon={LogOut} onClick={act(props.onDisconnect)}>
                Disconnect
              </Button>
            </div>
          </Match>
        </SolidSwitch>
      </div>
    </div>
  )
}
