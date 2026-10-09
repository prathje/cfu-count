import { createEffect, createSignal, Show } from 'solid-js'
import { Button } from './Button'

/** Options for a confirmation dialog. */
export interface ConfirmOptions {
  title: string
  body?: string
  confirmLabel: string
  cancelLabel?: string
  danger?: boolean
}

/** Options for a single-field text prompt. */
export interface PromptOptions {
  title: string
  label: string
  value?: string
  placeholder?: string
  confirmLabel: string
  body?: string
}

/** Promise-based modal dialogs (native <dialog>: focus trap, Escape and inert background for free). */
export interface Dialogs {
  confirm(opts: ConfirmOptions): Promise<boolean>
  prompt(opts: PromptOptions): Promise<string | null>
}

type Pending =
  | { kind: 'confirm'; opts: ConfirmOptions; resolve(v: boolean): void }
  | { kind: 'prompt'; opts: PromptOptions; resolve(v: string | null): void }

export function createDialogs(): Dialogs & { pending(): Pending | null; settle(value: unknown): void } {
  const [pending, setPending] = createSignal<Pending | null>(null)
  const settle = (value: unknown) => {
    const p = pending()
    if (!p) return
    setPending(null)
    if (p.kind === 'confirm') p.resolve(value === true)
    else p.resolve(typeof value === 'string' ? value : null)
  }
  return {
    pending,
    settle,
    confirm: (opts) =>
      new Promise((resolve) => {
        settle(null)
        setPending({ kind: 'confirm', opts, resolve })
      }),
    prompt: (opts) =>
      new Promise((resolve) => {
        settle(null)
        setPending({ kind: 'prompt', opts, resolve })
      }),
  }
}

/** Renders whichever dialog is pending. */
export function DialogHost(props: { dialogs: ReturnType<typeof createDialogs> }) {
  let dialog: HTMLDialogElement | undefined
  let input: HTMLInputElement | undefined
  const [value, setValue] = createSignal('')

  createEffect(() => {
    const p = props.dialogs.pending()
    if (!dialog) return
    if (p) {
      setValue(p.kind === 'prompt' ? (p.opts.value ?? '') : '')
      if (!dialog.open) dialog.showModal()
      queueMicrotask(() => (p.kind === 'prompt' ? input?.select() : dialog?.querySelector<HTMLElement>('[data-autofocus]')?.focus()))
    } else if (dialog.open) {
      dialog.close()
    }
  })

  const p = () => props.dialogs.pending()
  return (
    <dialog
      ref={dialog}
      class="dialog"
      aria-labelledby="dialog-title"
      onCancel={(e) => {
        e.preventDefault()
        props.dialogs.settle(null)
      }}
      onClick={(e) => {
        if (e.target === dialog) props.dialogs.settle(null)
      }}
    >
      <Show when={p()}>
        {(pending) => (
          <form
            method="dialog"
            class="dialog__form"
            onSubmit={(e) => {
              e.preventDefault()
              const cur = pending()
              if (cur.kind === 'confirm') props.dialogs.settle(true)
              else if (value().trim()) props.dialogs.settle(value().trim())
            }}
          >
            <h2 id="dialog-title" class="dialog__title">
              {pending().opts.title}
            </h2>
            <Show when={pending().opts.body}>
              <p class="dialog__body">{pending().opts.body}</p>
            </Show>
            <Show when={pending().kind === 'prompt' ? (pending().opts as PromptOptions) : null}>
              {(opts) => (
                <label class="field">
                  <span class="field__label">{opts().label}</span>
                  <input
                    ref={input}
                    class="field__input"
                    value={value()}
                    placeholder={opts().placeholder}
                    maxLength={120}
                    onInput={(e) => setValue(e.currentTarget.value)}
                  />
                </label>
              )}
            </Show>
            <div class="dialog__actions">
              <Button variant="ghost" onClick={() => props.dialogs.settle(null)}>
                {(pending().kind === 'confirm' && (pending().opts as ConfirmOptions).cancelLabel) || 'Cancel'}
              </Button>
              <Button
                type="submit"
                data-autofocus
                variant={pending().kind === 'confirm' && (pending().opts as ConfirmOptions).danger ? 'danger' : 'primary'}
                disabled={pending().kind === 'prompt' && !value().trim()}
              >
                {pending().opts.confirmLabel}
              </Button>
            </div>
          </form>
        )}
      </Show>
    </dialog>
  )
}
