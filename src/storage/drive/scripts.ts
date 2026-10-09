/** Load a third-party <script> once (memoised per URL). */
const loading = new Map<string, Promise<void>>()

export function loadScript(src: string): Promise<void> {
  let p = loading.get(src)
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      if (typeof document === 'undefined') {
        reject(new Error('Scripts can only be loaded in a browser'))
        return
      }
      const el = document.createElement('script')
      el.src = src
      el.async = true
      el.onload = () => resolve()
      el.onerror = () => {
        loading.delete(src)
        el.remove()
        reject(new Error(`Could not load ${new URL(src).host} (offline or blocked by a content blocker?)`))
      }
      document.head.appendChild(el)
    })
    loading.set(src, p)
  }
  return p
}
