import { createEffect, createSignal, Show } from 'solid-js'

/** Text that turns into an input for renaming. Enter/blur commits, Escape cancels. */
export interface InlineEditProps {
  value: string
  /** Accessible name of the input, e.g. "Project name". */
  label: string
  onCommit(value: string): void
  /** Controlled editing state (optional). */
  editing?: boolean
  onEditingChange?(editing: boolean): void
  class?: string
  maxLength?: number
}

export function InlineEdit(props: InlineEditProps) {
  const [localEditing, setLocalEditing] = createSignal(false)
  const editing = () => props.editing ?? localEditing()
  const setEditing = (v: boolean) => {
    setLocalEditing(v)
    props.onEditingChange?.(v)
  }
  let input: HTMLInputElement | undefined

  createEffect(() => {
    if (editing()) queueMicrotask(() => input?.select())
  })

  const commit = () => {
    const v = input?.value.trim() ?? ''
    if (v && v !== props.value) props.onCommit(v)
    setEditing(false)
  }

  return (
    <Show
      when={editing()}
      fallback={
        <button type="button" class={`inline-edit ${props.class ?? ''}`} onClick={() => setEditing(true)} title={`Rename — ${props.value}`}>
          <span class="inline-edit__text">{props.value}</span>
        </button>
      }
    >
      <input
        ref={input}
        class={`inline-edit__input ${props.class ?? ''}`}
        value={props.value}
        aria-label={props.label}
        maxLength={props.maxLength ?? 120}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') {
            e.preventDefault()
            setEditing(false)
          }
        }}
        onBlur={commit}
      />
    </Show>
  )
}
