/**
 * User-facing project actions that need dialogs, file pickers or downloads
 * around an editor command (confirmations, naming, zip routing). Shared by the
 * app bar, sidebar, empty states and workspace containers.
 */
import type { ID } from '../model/types'
import type { Editor } from '../state/editor'
import { downloadBlob, IMAGE_ACCEPT, pickFiles, safeFilename } from './download'
import type { ThumbnailCache } from './images'
import type { Dialogs } from './primitives'

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
}

export function defaultProjectName(date = new Date()): string {
  return `Plates ${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`
}

/** Body of the "remove image" confirmation (exported for tests). */
export function removeImageBody(annotationCount: number, fromDrive: boolean): string {
  const parts = [
    annotationCount
      ? `Its ${annotationCount.toLocaleString()} ${annotationCount === 1 ? 'annotation' : 'annotations'} are removed too. This can’t be undone.`
      : 'The image is removed from this project.',
  ]
  if (fromDrive) parts.push('The file stays in Google Drive and won’t be added back automatically.')
  return parts.join(' ')
}

export function createProjectActions(editor: Editor, dialogs: Dialogs, thumbnails: ThumbnailCache): ProjectActions {
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
      if (blob && state.project) downloadBlob(blob, `${safeFilename(state.project.name)}.zip`)
    },

    async downloadCsv() {
      const blob = await editor.projects.exportCsv()
      if (blob && state.project) downloadBlob(blob, `${safeFilename(state.project.name)} summary.csv`)
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
        title: `Remove “${img.name}”?`,
        body: removeImageBody(editor.images.confirmedCount(imageId), img.source.kind === 'drive'),
        confirmLabel: 'Remove image',
        danger: true,
      })
      if (!ok) return
      thumbnails.forget(imageId)
      await editor.images.remove(imageId)
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
