/**
 * User-facing project actions that need dialogs, file pickers or downloads
 * around an editor command (confirmations, naming, zip routing). Shared by the
 * app bar, sidebar, empty states and workspace containers.
 */
import type { ID } from '../model/types'
import type { ClearScope, ClearSummary, Editor } from '../state/editor'
import { downloadBlob, IMAGE_ACCEPT, pickFiles, safeFilename } from './download'
import type { Dialogs } from './primitives'
import type { Notify } from '../state/messages'
import { plural } from './format'

export interface ProjectActions {
  newProject(): Promise<void>
  deleteProject(): Promise<void>
  /** Route dropped/picked files: .zip archives are imported as projects, images into the open (or a new) project. */
  importFiles(files: File[], imageGroupId?: ID | null): Promise<void>
  chooseImages(imageGroupId?: ID | null): Promise<void>
  chooseArchive(): Promise<void>
  downloadArchive(): Promise<void>
  downloadCsv(): Promise<void>
  renameImage(imageId: ID): Promise<void>
  removeImage(imageId: ID): Promise<void>
  deleteImageGroup(id: ID): Promise<void>
  deleteAnnotationGroup(id: ID): Promise<void>
  /** "Clear annotations…" of a group: on this image or on every image, after a confirmation. */
  clearGroupAnnotations(id: ID): Promise<void>
}

export function defaultProjectName(date = new Date()): string {
  return `Plates ${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`
}

/**
 * Body of the "remove image" confirmation (exported for tests). Removing is a soft
 * delete: nothing is erased and the image can be restored. `annotationCount` counts
 * every stored annotation of the image, not only confirmed ones.
 */
export function removeImageBody(annotationCount: number, fromDrive: boolean): string {
  const kept = [
    annotationCount ? `its ${annotationCount.toLocaleString()} ${annotationCount === 1 ? 'annotation' : 'annotations'}` : null,
    fromDrive ? 'the file in Google Drive' : 'the image file',
  ].filter(Boolean)
  return `It’s hidden from the image list, counts and the CSV summary. Nothing is erased: ${kept.join(' and ')} ${kept.length > 1 ? 'are' : 'is'} kept, and you can restore it from “Recently removed” in the sidebar.`
}

/** One scope option's detail line in the "Clear annotations" dialog (exported for tests). */
export function clearScopeDetail(s: ClearSummary, scope: ClearScope): string {
  const origin = `${s.manual.toLocaleString()} manual, ${s.automated.toLocaleString()} automated`
  if (scope === 'image') return s.total ? `${plural(s.total, 'annotation')} on this image (${origin}).` : 'No annotations of this group on this image.'
  return s.total
    ? `${plural(s.total, 'annotation')} on ${plural(s.images, 'image')} (${origin}). Undo works per image.`
    : 'No annotations of this group on any image.'
}

export function createProjectActions(editor: Editor, dialogs: Dialogs, notify: Notify): ProjectActions {
  const { state } = editor

  async function ensureProject(): Promise<boolean> {
    if (state.project) return true
    return editor.projects.create(defaultProjectName())
  }

  async function importFiles(files: File[], imageGroupId: ID | null = null) {
    const zips = files.filter((f) => f.name.toLowerCase().endsWith('.zip'))
    const images = files.filter((f) => !zips.includes(f))
    for (const zip of zips) await editor.projects.importArchive(zip)
    if (images.length && (await ensureProject())) await editor.images.import(images, imageGroupId)
  }

  return {
    async newProject() {
      const name = await dialogs.prompt({
        title: 'New project',
        label: 'Project name',
        value: defaultProjectName(),
        confirmLabel: 'Create project',
        body: 'You can add image groups (e.g. treatments, batches, dilutions) after importing images.',
      })
      if (name) await editor.projects.create(name)
    },

    async deleteProject() {
      const p = state.project
      if (!p) return
      const ok = await dialogs.confirm({
        title: `Delete “${p.name}” from this browser?`,
        body:
          p.storage.kind === 'drive'
            ? 'The browser copy, its images and annotations are removed. The Google Drive folder is not touched.'
            : 'Its images and annotations are removed from this browser. Download a .zip first if you want a copy. This can’t be undone.',
        confirmLabel: 'Delete project',
        danger: true,
      })
      if (ok) await editor.projects.remove(p.id)
    },

    importFiles,

    async chooseImages(imageGroupId = null) {
      const files = await pickFiles({ accept: IMAGE_ACCEPT, multiple: true })
      if (files.length) await importFiles(files, imageGroupId)
    },

    async chooseArchive() {
      const [file] = await pickFiles({ accept: '.zip,application/zip' })
      if (file) await editor.projects.importArchive(file)
    },

    async downloadArchive() {
      const blob = await editor.projects.exportArchive()
      if (!blob || !state.project) return
      const name = `${safeFilename(state.project.name)}.zip`
      downloadBlob(blob, name)
      notify({ tone: 'success', key: 'export', message: `Downloaded ${name}`, detail: 'Images, annotations and summary. Open it again with Import project (.zip).' })
    },

    async downloadCsv() {
      const blob = await editor.projects.exportCsv()
      if (!blob || !state.project) return
      const name = `${safeFilename(state.project.name)} summary.csv`
      downloadBlob(blob, name)
      notify({ tone: 'success', key: 'export', message: `Exported ${name}`, detail: `${plural(editor.images.order().length, 'image')} · one row per image and annotation group` })
    },

    async renameImage(imageId) {
      const img = state.project?.images.find((i) => i.id === imageId)
      if (!img) return
      const name = await dialogs.prompt({ title: 'Rename image', label: 'Image name', value: img.name, confirmLabel: 'Rename' })
      if (name) editor.images.rename(imageId, name)
    },

    async removeImage(imageId) {
      const img = state.project?.images.find((i) => i.id === imageId)
      if (!img) return
      const ok = await dialogs.confirm({
        title: `Remove “${img.name}” from the project?`,
        body: removeImageBody(editor.images.annotationCount(imageId), img.source.kind === 'drive'),
        confirmLabel: 'Remove image',
      })
      if (!ok) return
      editor.images.remove(imageId)
      if (!state.project?.images.find((i) => i.id === imageId)?.deletedAt) return
      notify({ tone: 'success', key: 'remove-image', message: `Removed “${img.name}”`, detail: 'Find it under Recently removed in the sidebar.', action: { label: 'Restore', run: () => editor.images.restore(imageId) } })
    },

    async deleteImageGroup(id) {
      const g = state.project?.imageGroups.find((x) => x.id === id)
      if (!g) return
      const ok = await dialogs.confirm({
        title: `Delete image group “${g.name}”?`,
        body: 'Its images are kept and move to Ungrouped. Annotations are not affected.',
        confirmLabel: 'Delete group',
      })
      if (ok) editor.imageGroups.remove(id)
    },

    async clearGroupAnnotations(id) {
      const g = editor.groups.byId(id)
      if (!g || editor.annotations.explainGroupBlock(id)) return
      const here = editor.annotations.clearSummary(id, 'image')
      const all = editor.annotations.clearSummary(id, 'project')
      if (all.total === 0) {
        notify({ tone: 'info', key: 'clear-group', message: `“${g.name}” has no annotations to clear` })
        return
      }
      const scope = await dialogs.choose<ClearScope>({
        title: `Clear annotations in “${g.name}”?`,
        body: here.total
          ? `Remove ${plural(here.total, 'annotation')} from “${g.name}” on this image, or from every image. The group itself and records of Find similar runs are kept.`
          : `There are none on this image. Remove them from every image? The group itself and records of Find similar runs are kept.`,
        options: [
          { value: 'image', label: 'This image', detail: clearScopeDetail(here, 'image'), disabled: here.total === 0 },
          { value: 'project', label: 'All images in the project', detail: clearScopeDetail(all, 'project') },
        ],
        value: here.total ? 'image' : 'project',
        confirmLabel: 'Clear annotations',
        danger: true,
      })
      if (!scope) return
      const imageId = state.currentImageId
      const done = editor.annotations.clearGroup(id, scope)
      if (!done || done.total === 0) return
      if (scope === 'project') {
        notify({
          tone: 'success',
          key: 'clear-group',
          message: `Removed ${plural(done.total, 'annotation')} from “${g.name}” on ${plural(done.images, 'image')}`,
          detail: 'Undo works per image: open an image and press Undo to bring its marks back.',
        })
        return
      }
      const entryId = imageId ? state.history[imageId]?.undo.at(-1)?.id : undefined
      notify({
        tone: 'success',
        key: 'clear-group',
        message: `Removed ${plural(done.total, 'annotation')} from “${g.name}”`,
        action: {
          label: 'Undo',
          run: () => {
            if (imageId && state.currentImageId === imageId && state.history[imageId]?.undo.at(-1)?.id === entryId) editor.annotations.undo()
            else notify({ tone: 'info', key: 'clear-group', message: 'Use Undo in the toolbar', detail: 'Other changes were made after clearing.' })
          },
        },
      })
    },

    async deleteAnnotationGroup(id) {
      const g = editor.groups.byId(id)
      if (!g) return
      const usage = editor.groups.usage(id)
      const ok = await dialogs.confirm({
        title: `Delete “${g.name}”?`,
        body: usage.annotations
          ? `This removes ${usage.annotations.toLocaleString()} ${usage.annotations === 1 ? 'annotation' : 'annotations'} on ${usage.images} ${usage.images === 1 ? 'image' : 'images'}. This can’t be undone.`
          : 'This group has no annotations.',
        confirmLabel: 'Delete group',
        danger: true,
      })
      if (ok) editor.groups.remove(id)
    },
  }
}
