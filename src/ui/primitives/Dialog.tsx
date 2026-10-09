import { createEffect, createSignal, For, Show } from 'solid-js'
import { Button } from './Button'

/** Options for a confirmation dialog. */
export interface ConfirmOptions {
  title: string
  body?: string
  confirmLabel: string
  cancelLabel?: string
  danger?: boolean
  /** Focus the cancel button instead of the confirm button (a second, deliberate step). */
  focusCancel?: boolean
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

/** Options for a confirmation with one choice among a few options (radio buttons). */
export interface ChooseOptions<T extends string = string> {
  title: string
  body?: string
  options: { value: T; label: string; detail?: string; disabled?: boolean }[]
  /** Initially selected option. */
  value: T
  confirmLabel: string
  danger?: boolean
}

/** Promise-based modal dialogs (native <dialog>: focus trap, Escape and inert background for free). */
export interface Dialogs {
  confirm(opts: ConfirmOptions): Promise<boolean>
  prompt(opts: PromptOptions): Promise<string | null>
  /** Resolves with the chosen option, or null when cancelled. */
  choose<T extends string>(opts: ChooseOptions<T>): Promise<T | null>
}

type Pending =
  | { kind: 'confirm'; opts: ConfirmOptions; resolve(v: boolean): void }
  | { kind: 'prompt'; opts: PromptOptions; resolve(v: string | null): void }
  | { kind: 'choose'; opts: ChooseOptions; resolve(v: string | null): void }

/** Dialogs plus the state DialogHost renders (created once by the composition root). */
export interface DialogController extends Dialogs {
  pending(): Pending | null
  settle(value: unknown): void
}

export function createDialogs(): DialogController {
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
    choose: <T extends string>(opts: ChooseOptions<T>) =>
      new Promise<T | null>((resolve) => {
        settle(null)
        setPending({ kind: 'choose', opts: opts as ChooseOptions, resolve: resolve as (v: string | null) => void })
      }),
  }
}

/** Renders whichever dialog is pending. */
export function DialogHost(props: { dialogs: DialogController }) {
  let dialog: HTMLDialogElement | undefined
  let input: HTMLInputElement | undefined
  const [value, setValue] = createSignal('')

  createEffect(() => {
    const p = props.dialogs.pending()
    if (!dialog) return
    if (p) {
      setValue(p.kind === 'prompt' ? (p.opts.value ?? '') : p.kind === 'choose' ? p.opts.value : '')
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
              else if (cur.kind === 'choose') props.dialogs.settle(value())
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
            <Show when={pending().kind === 'choose' ? (pending().opts as ChooseOptions) : null}>
              {(opts) => (
                <fieldset class="dialog__choices">
                  <legend class="sr-only">{opts().title}</legend>
                  <For each={opts().options}>
                    {(o) => (
                      <label class="dialog__choice" classList={{ 'is-disabled': o.disabled }}>
                        <input type="radio" name="dialog-choice" value={o.value} checked={value() === o.value} disabled={o.disabled} onChange={() => setValue(o.value)} />
                        <span>
                          <span class="dialog__choice-label">{o.label}</span>
                          <Show when={o.detail}>
                            <span class="dialog__choice-detail">{o.detail}</span>
                          </Show>
                        </span>
                      </label>
                    )}
                  </For>
                </fieldset>
              )}
            </Show>
            <div class="dialog__actions">
              <Button
                variant="ghost"
                onClick={() => props.dialogs.settle(null)}
                data-autofocus={pending().kind === 'confirm' && (pending().opts as ConfirmOptions).focusCancel ? true : undefined}
              >
                {(pending().kind === 'confirm' && (pending().opts as ConfirmOptions).cancelLabel) || 'Cancel'}
              </Button>
              <Button
                type="submit"
                data-autofocus={pending().kind === 'confirm' && (pending().opts as ConfirmOptions).focusCancel ? undefined : true}
                variant={pending().kind !== 'prompt' && (pending().opts as ConfirmOptions).danger ? 'danger' : 'primary'}
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
