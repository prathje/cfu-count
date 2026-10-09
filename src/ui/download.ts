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

/** Open a native file picker and resolve with the chosen files (empty if cancelled). */
export function pickFiles(opts: { accept: string; multiple?: boolean }): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = opts.accept
    input.multiple = !!opts.multiple
    input.style.display = 'none'
    input.addEventListener('change', () => {
      resolve([...(input.files ?? [])])
      input.remove()
    })
    input.addEventListener('cancel', () => {
      resolve([])
      input.remove()
    })
    document.body.appendChild(input)
    input.click()
  })
}

export const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif,image/avif,image/bmp,image/gif,image/tiff'
