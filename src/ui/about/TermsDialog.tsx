import { createEffect, Show } from 'solid-js'
import { Button } from '../primitives'
import { LICENSE_URL, REPO_URL } from './terms'
import './terms.css'

/**
 * Terms of use. `mode: 'first-run'` is a blocking modal with a single Accept
 * button (Escape and backdrop clicks do nothing); `mode: 'view'` re-opens the
 * same text from Settings with a Close button.
 */
export interface TermsDialogProps {
  open: boolean
  mode: 'first-run' | 'view'
  onAccept(): void
  onClose(): void
}

export function TermsDialog(props: TermsDialogProps) {
  let dialog: HTMLDialogElement | undefined
  let accept: HTMLButtonElement | undefined
  createEffect(() => {
    if (!dialog) return
    if (props.open && !dialog.open) {
      dialog.showModal()
      queueMicrotask(() => accept?.focus())
    } else if (!props.open && dialog.open) dialog.close()
  })
  const firstRun = () => props.mode === 'first-run'
  return (
    <dialog
      ref={dialog}
      class="dialog terms-dialog"
      aria-labelledby="terms-title"
      aria-describedby="terms-body"
      onCancel={(e) => {
        e.preventDefault()
        if (!firstRun()) props.onClose()
      }}
      onClick={(e) => !firstRun() && e.target === dialog && props.onClose()}
    >
      <div class="dialog__form">
        <h2 id="terms-title" class="dialog__title">
          Terms of use
        </h2>
        <div id="terms-body" class="terms-dialog__body">
          <p>
            CFU Count is provided <strong>“as is”, without warranty of any kind</strong>, express or implied, and without
            any guarantee of correctness, availability or fitness for a particular purpose. You use it at your own risk; the
            authors are not liable for any claim, damages or loss arising from its use.
          </p>
          <p class="terms-dialog__warn">
            The software is at an <strong>early stage</strong> and <strong>loss of data is likely</strong>. Please download
            your project regularly (project menu → <em>Download project (.zip)</em>) and keep your own copies.
          </p>
          <p>
            Automated counts are suggestions and must be reviewed. Everything runs in your browser; images are only sent to
            Google Drive if you connect it.
          </p>
          <p class="terms-dialog__links">
            Open source under the{' '}
            <a href={LICENSE_URL} target="_blank" rel="noopener noreferrer">
              MIT License
            </a>{' '}
            ·{' '}
            <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
              Source code on GitHub
            </a>
          </p>
        </div>
        <div class="terms-dialog__actions">
          <Show
            when={firstRun()}
            fallback={
              <Button ref={accept} variant="primary" onClick={() => props.onClose()}>
                Close
              </Button>
            }
          >
            <Button ref={accept} variant="primary" onClick={() => props.onAccept()}>
              I understand and accept
            </Button>
          </Show>
        </div>
      </div>
    </dialog>
  )
}
