/** Save a blob as a file via a temporary object URL (revoked after the click). */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** File-system-safe version of a project name. */
export function safeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'project'
}

/** After the page regains focus, wait this long for `change` before treating the picker as cancelled. */
export const PICKER_FOCUS_GRACE_MS = 1000

/**
 * Open a native file picker and resolve with the chosen files (empty if cancelled).
 * Older iOS / iPadOS Safari never fires `cancel`, so the promise also settles when
 * the page gets focus back and no file arrives within PICKER_FOCUS_GRACE_MS.
 */
export function pickFiles(opts: { accept: string; multiple?: boolean }): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = opts.accept
    input.multiple = !!opts.multiple
    input.style.display = 'none'
    let timer: ReturnType<typeof setTimeout> | undefined
    let done = false
    const finish = (files: File[]) => {
      if (done) return
      done = true
      clearTimeout(timer)
      window.removeEventListener('focus', onFocus)
      input.remove()
      resolve(files)
    }
    const onFocus = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (!input.files?.length) finish([])
      }, PICKER_FOCUS_GRACE_MS)
    }
    input.addEventListener('change', () => finish([...(input.files ?? [])]))
    input.addEventListener('cancel', () => finish([]))
    document.body.appendChild(input)
    input.click()
    // Registered after click(): the picker takes focus away; its return means it closed.
    window.addEventListener('focus', onFocus)
  })
}

export const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif,image/avif,image/bmp,image/gif,image/tiff'
