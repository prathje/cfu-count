/** Window-wide drag & drop of files, for the lifetime of the calling owner. */
import { createSignal, onCleanup, type Accessor } from 'solid-js'

/**
 * Calls `onFiles` with files dropped anywhere on the window. Returns whether files
 * are currently being dragged over the window (for a drop overlay).
 */
export function createFileDrop(onFiles: (files: File[]) => void): Accessor<boolean> {
  const [dragging, setDragging] = createSignal(false)
  // dragenter/dragleave fire for every child element; count to know when we really left.
  let depth = 0
  const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files')
  const onEnter = (e: DragEvent) => {
    if (!hasFiles(e)) return
    depth++
    setDragging(true)
  }
  const onOver = (e: DragEvent) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.dataTransfer!.dropEffect = 'copy'
  }
  const onLeave = (e: DragEvent) => {
    if (!hasFiles(e)) return
    depth = Math.max(0, depth - 1)
    if (depth === 0) setDragging(false)
  }
  const onDrop = (e: DragEvent) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    depth = 0
    setDragging(false)
    const files = [...(e.dataTransfer?.files ?? [])]
    if (files.length) onFiles(files)
  }
  window.addEventListener('dragenter', onEnter)
  window.addEventListener('dragover', onOver)
  window.addEventListener('dragleave', onLeave)
  window.addEventListener('drop', onDrop)
  onCleanup(() => {
    window.removeEventListener('dragenter', onEnter)
    window.removeEventListener('dragover', onOver)
    window.removeEventListener('dragleave', onLeave)
    window.removeEventListener('drop', onDrop)
  })
  return dragging
}
