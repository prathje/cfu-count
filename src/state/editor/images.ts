/** Images of the open project: selection, naming, grouping, import and removal. */
import { batch, createMemo, type Accessor } from 'solid-js'
import { unwrap } from 'solid-js/store'
import type { ID, ImageDisplayAdjust, ImageRecord } from '../../model/types'
import { storedDisplay } from '../../model/display'
import { confirmedCount } from '../../model/annotations'
import { displayOrder, isRemoved, removedImages } from '../../model/project'
import type { ImportResult } from '../../storage/api'
import { prefs } from '../prefs'
import { now } from '../../model/ids'
import { errorText, type EditorContext } from './context'

export interface ImageCommands {
  /** The selected image (never a removed one). */
  current: Accessor<ImageRecord | null>
  /** All images that are not removed, in display order (image-group order, then ungrouped). */
  order: Accessor<readonly ImageRecord[]>
  /** Removed images, most recently removed first ("Recently removed"). */
  removed: Accessor<readonly ImageRecord[]>
  /** Confirmed annotation count of any image. */
  confirmedCount(imageId: ID): number
  /** Number of annotations stored for an image (every origin and review state). */
  annotationCount(imageId: ID): number

  select(imageId: ID | null): void
  selectAdjacent(delta: number): void
  rename(imageId: ID, name: string): void
  /** Reassign an image; its annotations are unaffected. Unknown groups are ignored. */
  assign(imageId: ID, imageGroupId: ID | null): void
  /** Import local files, optionally into an image group (ungrouped if that group is gone by then). */
  import(files: File[], imageGroupId?: ID | null): Promise<void>
  /** Pick images in Google Drive. Call synchronously from the click (may open a sign-in popup). */
  importFromDrive(imageGroupId?: ID | null): Promise<void>
  /**
   * Remove from the project (soft delete: sets `deletedAt` in project.json). Nothing is
   * erased: bytes, annotations and the Drive file stay, and `restore` brings it back.
   */
  remove(imageId: ID): void
  /** Undo a removal: the image is back in its image group (or ungrouped) and selected. */
  restore(imageId: ID): void
  /** Original bytes of an image in the open project. */
  blob(imageId: ID): Promise<Blob>
  /**
   * Set how images are DISPLAYED (view setting: allowed while groups are locked,
   * not undoable, dirties project.json only). null/default removes the field.
   */
  setDisplay(imageIds: readonly ID[], display: ImageDisplayAdjust | null): void
}

export function createImages(ctx: EditorContext): ImageCommands {
  const { state, setState, notify } = ctx

  const current = createMemo<ImageRecord | null>(() => {
    const img = state.project?.images.find((i) => i.id === state.currentImageId)
    return img && !isRemoved(img) ? img : null
  })
  const order = createMemo<readonly ImageRecord[]>(() => (state.project ? displayOrder(state.project) : []))
  const removed = createMemo<readonly ImageRecord[]>(() => (state.project ? removedImages(state.project) : []))

  const setImages = (map: (images: ImageRecord[]) => ImageRecord[]) => setState('project', 'images', map(unwrap(state.project!.images)))

  function select(imageId: ID | null) {
    if (imageId && !state.project?.images.some((i) => i.id === imageId && !isRemoved(i))) return
    setState('currentImageId', imageId)
    if (state.project && imageId) prefs.set(`lastImage:${state.project.id}`, imageId)
  }

  function selectAdjacent(delta: number) {
    const list = order()
    if (!list.length) return
    const i = list.findIndex((img) => img.id === state.currentImageId)
    select(list[Math.max(0, Math.min(list.length - 1, (i < 0 ? 0 : i) + delta))].id)
  }

  function rename(imageId: ID, name: string) {
    const trimmed = name.trim()
    if (!state.project || !trimmed || ctx.editsFrozen()) return
    setImages((imgs) => imgs.map((img) => (img.id === imageId ? { ...img, name: trimmed } : img)))
    ctx.touchProject()
  }

  function assign(imageId: ID, imageGroupId: ID | null) {
    if (!state.project || ctx.editsFrozen()) return
    if (imageGroupId && !state.project.imageGroups.some((g) => g.id === imageGroupId)) return
    setImages((imgs) => imgs.map((img) => (img.id === imageId ? { ...img, imageGroupId } : img)))
    ctx.touchProject()
  }

  /** Add records returned by storage. The target group is checked NOW (it may have been deleted mid-import). */
  function addImported(result: ImportResult, imageGroupId: ID | null) {
    reportRejected(result.rejected)
    const added = result.added
    if (!state.project || added.length === 0) return
    const target = imageGroupId && state.project.imageGroups.some((g) => g.id === imageGroupId) ? imageGroupId : null
    const known = new Set(state.project.images.map((i) => i.id))
    const fresh = added.filter((img) => !known.has(img.id)).map((img) => ({ ...img, imageGroupId: target }))
    batch(() => {
      if (fresh.length) setImages((imgs) => [...imgs, ...fresh])
      if (!current()) select(added[0].id)
    })
    ctx.touchProject()
    notify({
      tone: 'success',
      key: 'import',
      message: added.length === 1 ? `Imported “${added[0].name}”` : `Imported ${added.length} images`,
      detail: imageGroupId && !target ? 'The image group was deleted meanwhile, so the images are ungrouped.' : undefined,
    })
  }

  function reportRejected(rejected: ImportResult['rejected']) {
    if (!rejected.length) return
    notify({
      tone: 'warning',
      message: rejected.length === 1 ? `Couldn’t import “${rejected[0].name}”` : `${rejected.length} files couldn’t be imported`,
      detail: rejected
        .slice(0, 4)
        .map((r) => (rejected.length === 1 ? r.reason : `${r.name}: ${r.reason}`))
        .join(' · '),
    })
  }

  async function importFiles(files: File[], imageGroupId: ID | null = null) {
    const session = ctx.session()
    if (!session || files.length === 0 || ctx.editsFrozen()) return
    setState('importing', (n) => n + files.length)
    try {
      addImported(await session.images.import(files), imageGroupId)
    } catch (err) {
      notify({ tone: 'error', message: 'Import failed', detail: errorText(err) })
    } finally {
      setState('importing', (n) => Math.max(0, n - files.length))
    }
  }

  async function importFromDrive(imageGroupId: ID | null = null) {
    const session = ctx.session()
    if (!session || ctx.editsFrozen()) return
    // session.images.importFromDrive starts sign-in synchronously (inside this click).
    const result = await ctx.run('Importing from Google Drive…', () => session.images.importFromDrive(), 'Couldn’t import images from Google Drive')
    if (result) addImported(result, imageGroupId)
  }

  function remove(imageId: ID) {
    const image = state.project?.images.find((i) => i.id === imageId)
    if (!image || isRemoved(image) || ctx.editsFrozen()) return
    batch(() => {
      if (state.currentImageId === imageId) {
        const list = order()
        const i = list.findIndex((img) => img.id === imageId)
        const next = list[i + 1] ?? list[i - 1]
        setState('currentImageId', next && next.id !== imageId ? next.id : null)
      }
      // Annotation documents and undo history stay: restoring brings everything back.
      setImages((imgs) => imgs.map((img) => (img.id === imageId ? { ...img, deletedAt: now() } : img)))
    })
    ctx.touchProject()
  }

  function restore(imageId: ID) {
    const image = state.project?.images.find((i) => i.id === imageId)
    if (!image || !isRemoved(image) || ctx.editsFrozen()) return
    batch(() => {
      setImages((imgs) =>
        imgs.map((img) => {
          if (img.id !== imageId) return img
          const { deletedAt: _removed, ...rest } = img
          return rest
        }),
      )
      select(imageId)
    })
    ctx.touchProject()
  }

  function blob(imageId: ID): Promise<Blob> {
    const session = ctx.session()
    return session ? session.images.blob(imageId) : Promise.reject(new Error('No project open.'))
  }

  function setDisplay(imageIds: readonly ID[], display: ImageDisplayAdjust | null) {
    if (!state.project || imageIds.length === 0 || ctx.editsFrozen()) return
    const ids = new Set(imageIds)
    const value = storedDisplay(display)
    setImages((imgs) =>
      imgs.map((img) => {
        if (!ids.has(img.id)) return img
        const { display: _old, ...rest } = img
        return value ? { ...rest, display: { ...value } } : rest
      }),
    )
    ctx.touchProject()
  }

  return {
    current,
    order,
    removed,
    confirmedCount: (imageId) => confirmedCount(state.docs[imageId]?.annotations),
    annotationCount: (imageId) => state.docs[imageId]?.annotations.length ?? 0,
    select,
    selectAdjacent,
    rename,
    assign,
    import: importFiles,
    importFromDrive,
    remove,
    restore,
    blob,
    setDisplay,
  }
}
