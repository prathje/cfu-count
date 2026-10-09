import { createEffect, For } from 'solid-js'
import type { ShortcutRow, ShortcutSection } from '../shortcuts'
import { Keyboard, X } from '../icons'
import './shortcut-sheet.css'

/** Modal cheat sheet of keyboard shortcuts. Rows come from the shortcut table (ui/shortcuts.ts). */
export interface ShortcutSheetProps {
  open: boolean
  sections: readonly { section: ShortcutSection; rows: readonly ShortcutRow[] }[]
  onClose(): void
}

export function ShortcutSheet(props: ShortcutSheetProps) {
  let dialog: HTMLDialogElement | undefined
  createEffect(() => {
    if (!dialog) return
    if (props.open && !dialog.open) dialog.showModal()
    else if (!props.open && dialog.open) dialog.close()
  })
  return (
    <dialog
      ref={dialog}
      class="dialog shortcut-sheet"
      aria-labelledby="shortcut-sheet-title"
      onCancel={(e) => {
        e.preventDefault()
        props.onClose()
      }}
      onClick={(e) => e.target === dialog && props.onClose()}
    >
      <div class="shortcut-sheet__head">
        <Keyboard size={18} aria-hidden="true" />
        <h2 id="shortcut-sheet-title" class="dialog__title">
          Keyboard shortcuts
        </h2>
        <button type="button" class="shortcut-sheet__close" aria-label="Close" onClick={() => props.onClose()}>
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      <div class="shortcut-sheet__grid">
        <For each={props.sections}>
          {(s) => (
            <section class="shortcut-sheet__section" aria-label={s.section}>
              <h3 class="section-label">{s.section}</h3>
              <dl>
                <For each={s.rows}>
                  {(r) => (
                    <div class="shortcut-sheet__row">
                      <dt>{r.label}</dt>
                      <dd>
                        <For each={r.keys}>{(k) => (k === '…' ? <span class="shortcut-sheet__ellipsis">–</span> : <kbd>{k}</kbd>)}</For>
                      </dd>
                    </div>
                  )}
                </For>
              </dl>
            </section>
          )}
        </For>
      </div>
      <p class="shortcut-sheet__foot">Shortcuts are off while you type in a text field.</p>
    </dialog>
  )
}
