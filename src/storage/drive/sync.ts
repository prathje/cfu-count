/**
 * Drive sync engine: push a local project into its Drive folder and pull a
 * folder into a project. Pure over the DriveClient seam (no globals, no IndexedDB),
 * so it is unit-tested against an in-memory fake Drive.
 *
 * Folder layout (the folder IS the project):
 *   project.json                 written LAST on every push (acts as the commit marker)
 *   summary.csv                  derived; always overwritten
 *   annotations/<imageId>.json   one per image
 *   images/<name>                local images uploaded so the project reopens elsewhere
 * Images picked from anywhere in Drive stay where they are; their file ID is identity.
 *
 * Conflict rule: an existing output file is only overwritten if its current
 * md5Checksum equals the one this browser last read/wrote (link.remoteVersions).
 * A file referenced but never read here (e.g. not yet granted under drive.file)
 * also counts as a conflict. Drive has no compare-and-swap, so a small race
 * window between check and write remains; it is documented, not hidden.
 */
import { SCHEMA_VERSION } from '../../model/types'
import type { ID, ImageAnnotations, ImageRecord, Project, ProjectStorageLink } from '../../model/types'
import { newId } from '../../model/ids'
import { buildSummaryCsv } from '../csv'
import { encodeJson, toSharedProject } from '../documents'
import { DriveError, SchemaError } from '../errors'
import { inspectImage, sha256Hex, type ImageDecoder } from '../images'
import { parseJson, validateImageAnnotations, validateProject } from '../validate'
import { FOLDER_MIME, type DriveClient, type DriveFile, type NewFileMetadata } from './client'

export type DriveLink = Extract<ProjectStorageLink, { kind: 'drive' }>

export const PROJECT_JSON = 'project.json'
export const SUMMARY_CSV = 'summary.csv'
export const ANNOTATIONS_DIR = 'annotations'
export const IMAGES_DIR = 'images'

/** appProperties keys written on every file we create (private to this app). */
const KEY = 'cfuKey'
const SHA = 'cfuSha256'
const IMAGE_ID = 'cfuImageId'

export function newDriveLink(folderId: string, folderName: string): DriveLink {
  return { kind: 'drive', folderId, folderName, files: { annotations: {} }, remoteVersions: {} }
}

export function isDriveLinked(p: Project): p is Project & { storage: DriveLink } {
  return p.storage.kind === 'drive'
}

function cloneLink(l: DriveLink): DriveLink {
  return { ...l, files: { ...l.files, annotations: { ...l.files.annotations } }, remoteVersions: { ...l.remoteVersions } }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return out
}

const isFolder = (f: DriveFile) => f.mimeType === FOLDER_MIME
const isImage = (f: DriveFile) => f.mimeType.startsWith('image/')

/** Verify the folder still exists, is a folder and is writable. */
export async function checkFolder(client: DriveClient, folderId: string): Promise<DriveFile> {
  let folder: DriveFile
  try {
    folder = await client.getFile(folderId)
  } catch (e) {
    if (e instanceof DriveError && e.kind === 'not-found') {
      throw new DriveError('not-found', "The project's Drive folder was deleted, or you no longer have access to it. Your work is safe in this browser; link the project to another folder.", { status: 404 })
    }
    throw e
  }
  if (folder.trashed) throw new DriveError('not-found', "The project's Drive folder is in the trash. Restore it in Google Drive, or link the project to another folder.")
  if (!isFolder(folder)) throw new DriveError('invalid', 'The selected Drive item is not a folder.')
  return folder
}

/** getFile that returns undefined for deleted / not-granted / trashed files. */
async function tryGet(client: DriveClient, id: string | undefined): Promise<DriveFile | undefined> {
  if (!id) return undefined
  try {
    const f = await client.getFile(id)
    return f.trashed ? undefined : f
  } catch (e) {
    if (e instanceof DriveError && (e.kind === 'not-found' || e.kind === 'forbidden')) return undefined
    throw e
  }
}

async function ensureSubfolder(client: DriveClient, parentId: string, name: string, knownId: string | undefined, siblings: DriveFile[]): Promise<string> {
  if (knownId && siblings.some((f) => f.id === knownId)) return knownId
  // Under drive.file a folder can be granted (picked) without being listable via its parent.
  if (knownId && (await tryGet(client, knownId))) return knownId
  const existing = siblings.find((f) => isFolder(f) && f.name === name)
  if (existing) return existing.id
  const created = await client.create({ name, parents: [parentId], mimeType: FOLDER_MIME, appProperties: { [KEY]: `dir:${name}` } })
  return created.id
}

// ---------------------------------------------------------------- push

/** Inputs for one push of a Drive-linked project. */
export interface PushInput {
  project: Project
  /** ALL annotation documents of the project (summary.csv is derived from them). */
  annotations: Map<ID, ImageAnnotations>
  /** Images whose annotation documents changed since the last successful push. */
  dirtyImages: Set<ID>
  loadImage(imageId: ID): Promise<Blob | undefined>
  /** Write even if remote files changed (user chose "keep mine"). */
  overwrite: boolean
  /**
   * Persist progress after each created/updated file, so an interrupted push
   * resumes with the same file IDs instead of creating duplicates.
   */
  checkpoint(project: Project, writtenImages: ID[]): Promise<void>
}

export type PushResult =
  | { kind: 'saved'; project: Project; warnings: string[] }
  | { kind: 'conflict'; files: string[] }

export async function pushProject(client: DriveClient, input: PushInput): Promise<PushResult> {
  if (!isDriveLinked(input.project)) throw new Error('pushProject requires a Drive-linked project')
  const link = cloneLink(input.project.storage)
  let project: Project = { ...input.project, storage: link, images: input.project.images.map((i) => ({ ...i })) }
  const warnings: string[] = []

  const folder = await checkFolder(client, link.folderId)
  if (folder.capabilities?.canAddChildren === false) {
    throw new DriveError('forbidden', `You only have view access to the Drive folder "${folder.name}". Ask the owner for edit access, or link the project to a folder you can edit.`)
  }
  link.folderName = folder.name
  const root = await client.listChildren(link.folderId)
  link.files.annotationsFolder = await ensureSubfolder(client, link.folderId, ANNOTATIONS_DIR, link.files.annotationsFolder, root)
  const annFiles = await client.listChildren(link.files.annotationsFolder)
  const annById = new Map(annFiles.map((f) => [f.id, f]))

  // ---- plan + conflict detection (no writes yet) ----
  const conflicts: string[] = []
  const known = (id: string | undefined, listing: Map<string, DriveFile>) => (id ? listing.get(id) : undefined)
  const rootById = new Map(root.map((f) => [f.id, f]))

  let projectTarget: string | undefined
  const pjKnown = known(link.files.projectJson, rootById)
  if (pjKnown) {
    projectTarget = pjKnown.id
    if (pjKnown.md5Checksum !== link.remoteVersions[pjKnown.id]) conflicts.push(PROJECT_JSON)
  } else if (link.files.projectJson && link.remoteVersions[link.files.projectJson] === undefined) {
    // Referenced but never read here (not granted to this app yet): don't clobber it with a new file.
    projectTarget = link.files.projectJson
    conflicts.push(PROJECT_JSON)
  } else {
    // A project.json we don't know about (another device's first save, or a retried create).
    const other = root.find((f) => f.name === PROJECT_JSON && !isFolder(f))
    if (other) {
      projectTarget = other.id
      conflicts.push(PROJECT_JSON)
    }
  }

  interface DocPlan { imageId: ID; body: Blob; sha: string; target?: string }
  const docPlans: DocPlan[] = []
  for (const image of project.images) {
    const doc = input.annotations.get(image.id)
    if (!doc) continue
    const fid = link.files.annotations[image.id]
    const remote = known(fid, annById)
    const neverRead = fid !== undefined && link.remoteVersions[fid] === undefined
    if (!input.dirtyImages.has(image.id) && remote && !neverRead) continue // up to date
    if (!input.dirtyImages.has(image.id) && neverRead) continue // untouched here; keep remote as is
    const text = encodeJson(doc)
    const body = new Blob([text], { type: 'application/json' })
    const sha = await sha256Hex(new TextEncoder().encode(text))
    const name = `${image.id}.json`
    const plan: DocPlan = { imageId: image.id, body, sha, target: remote?.id }
    if (remote) {
      if (remote.md5Checksum !== link.remoteVersions[remote.id]) conflicts.push(`${ANNOTATIONS_DIR}/${name}`)
    } else if (neverRead) {
      plan.target = fid
      conflicts.push(`${ANNOTATIONS_DIR}/${name}`)
    } else {
      const other = annFiles.find((f) => f.name === name)
      if (other) {
        plan.target = other.id
        // Same bytes as we are about to write = an earlier interrupted create of ours.
        if (other.appProperties?.[SHA] !== sha) conflicts.push(`${ANNOTATIONS_DIR}/${name}`)
      }
    }
    docPlans.push(plan)
  }

  if (conflicts.length && !input.overwrite) return { kind: 'conflict', files: conflicts }

  const save = (written: ID[] = []) => input.checkpoint(project, written)

  // ---- 1. upload images that only exist locally ----
  const localImages = project.images.filter((i) => i.source.kind === 'local')
  if (localImages.length) {
    link.files.imagesFolder = await ensureSubfolder(client, link.folderId, IMAGES_DIR, link.files.imagesFolder, root)
    const existing = await client.listChildren(link.files.imagesFolder)
    for (const image of localImages) {
      const blob = await input.loadImage(image.id)
      if (!blob) {
        warnings.push(`"${image.name}" has no image data in this browser and was not uploaded.`)
        continue
      }
      let file = existing.find((f) => f.appProperties?.[IMAGE_ID] === image.id && f.appProperties?.[SHA] === image.fingerprint)
      file ??= await client.create(
        { name: image.name, parents: [link.files.imagesFolder], mimeType: image.mimeType, appProperties: { [KEY]: `image:${image.id}`, [IMAGE_ID]: image.id, [SHA]: image.fingerprint } },
        blob.type === image.mimeType ? blob : new Blob([blob], { type: image.mimeType }),
      )
      image.source = { kind: 'drive', fileId: file.id, md5Checksum: file.md5Checksum, version: file.version }
      await save()
    }
  }

  // ---- 2. annotation documents ----
  for (const plan of docPlans) {
    const props = { [KEY]: `annotations:${plan.imageId}`, [SHA]: plan.sha }
    const f = await upsert(client, plan.target, { name: `${plan.imageId}.json`, parents: [link.files.annotationsFolder], mimeType: 'application/json', appProperties: props }, plan.body)
    link.files.annotations[plan.imageId] = f.id
    if (f.md5Checksum) link.remoteVersions[f.id] = f.md5Checksum
    await save([plan.imageId])
  }

  // ---- 3. summary.csv (derived: never a conflict) ----
  const csv = new Blob([buildSummaryCsv(project, input.annotations)], { type: 'text/csv' })
  // Update by ID even if not listed (granted individually); upsert recreates it only if gone.
  const csvTarget = link.files.summaryCsv ?? root.find((f) => f.name === SUMMARY_CSV && f.appProperties?.[KEY] === 'summary')?.id
  const csvFile = await upsert(client, csvTarget, { name: SUMMARY_CSV, parents: [link.folderId], mimeType: 'text/csv', appProperties: { [KEY]: 'summary' } }, csv)
  link.files.summaryCsv = csvFile.id

  // ---- 4. project.json last ----
  const pjBody = new Blob([encodeJson(toSharedProject(project))], { type: 'application/json' })
  const pjFile = await upsert(client, projectTarget, { name: PROJECT_JSON, parents: [link.folderId], mimeType: 'application/json', appProperties: { [KEY]: 'project' } }, pjBody)
  link.files.projectJson = pjFile.id
  if (pjFile.md5Checksum) link.remoteVersions[pjFile.id] = pjFile.md5Checksum
  project = { ...project, storage: link }
  return { kind: 'saved', project, warnings }
}

/** Update `targetId` in place; create the file only if there is no target or it no longer exists. */
async function upsert(client: DriveClient, targetId: string | undefined, meta: NewFileMetadata, body: Blob): Promise<DriveFile> {
  if (targetId) {
    try {
      return await client.updateContent(targetId, body, meta.appProperties)
    } catch (e) {
      if (!(e instanceof DriveError && e.kind === 'not-found')) throw e
    }
  }
  return client.create(meta, body)
}

// ---------------------------------------------------------------- pull

/** What a Drive folder contains, mapped onto the data model. */
export interface PullResult {
  folder: DriveFile
  /** null when no project.json is visible to this app in the folder. */
  project: (Project & { storage: DriveLink }) | null
  annotations: Map<ID, ImageAnnotations>
  /**
   * Referenced files this app cannot read (under drive.file: not granted yet, or deleted).
   * Offer the picker with these IDs (setFileIds) to grant access.
   */
  inaccessible: string[]
  /** Image files visible in the folder or images/ that the project does not reference yet. */
  unreferencedImages: DriveFile[]
  warnings: string[]
}

export async function pullFolder(client: DriveClient, folderId: string, now: () => string): Promise<PullResult> {
  const folder = await checkFolder(client, folderId)
  const root = await client.listChildren(folderId)
  const warnings: string[] = []
  const inaccessible: string[] = []
  const sub = (name: string) => root.filter((f) => isFolder(f) && f.name === name)[0]
  const imagesIn = async (dir: DriveFile | undefined) => [...root.filter(isImage), ...(dir ? (await client.listChildren(dir.id)).filter(isImage) : [])]

  const candidates = root
    .filter((f) => f.name === PROJECT_JSON && !isFolder(f))
    .sort((a, b) => (b.modifiedTime ?? '').localeCompare(a.modifiedTime ?? ''))
  if (candidates.length > 1) warnings.push(`The folder contains ${candidates.length} project.json files; the most recently modified one was used.`)
  const pj = candidates[0]
  if (!pj) {
    return { folder, project: null, annotations: new Map(), inaccessible, unreferencedImages: await imagesIn(sub(IMAGES_DIR)), warnings }
  }

  let remote: Project
  try {
    remote = validateProject(parseJson(await (await client.download(pj.id)).text(), PROJECT_JSON), PROJECT_JSON, warnings)
  } catch (e) {
    if (e instanceof SchemaError) throw new DriveError('invalid', `project.json in "${folder.name}" cannot be read: ${e.message}`)
    throw e
  }
  const remoteFiles: Partial<DriveLink['files']> = remote.storage.kind === 'drive' ? remote.storage.files : { annotations: {} }
  // Subfolders: visible by name, or referenced by ID and individually granted.
  const resolveDir = async (name: string, refId: string | undefined) => {
    const dir = sub(name) ?? (await tryGet(client, refId))
    if (!dir && refId) inaccessible.push(refId)
    return dir
  }
  const annDir = await resolveDir(ANNOTATIONS_DIR, remoteFiles.annotationsFolder)
  const imgDir = await resolveDir(IMAGES_DIR, remoteFiles.imagesFolder)
  const visibleImages = await imagesIn(imgDir)
  const link = newDriveLink(folderId, folder.name)
  link.files.projectJson = pj.id
  if (pj.md5Checksum) link.remoteVersions[pj.id] = pj.md5Checksum
  link.files.annotationsFolder = annDir?.id ?? remoteFiles.annotationsFolder
  link.files.imagesFolder = imgDir?.id ?? remoteFiles.imagesFolder
  const csv = root.find((f) => f.id === remoteFiles.summaryCsv) ?? root.find((f) => f.name === SUMMARY_CSV) ?? (await tryGet(client, remoteFiles.summaryCsv))
  if (!csv && remoteFiles.summaryCsv) inaccessible.push(remoteFiles.summaryCsv)
  link.files.summaryCsv = csv?.id ?? remoteFiles.summaryCsv

  const annFiles = annDir ? await client.listChildren(annDir.id) : []
  const annById = new Map(annFiles.map((f) => [f.id, f]))
  const annotations = new Map<ID, ImageAnnotations>()

  await mapLimit(remote.images, 4, async (image) => {
    const refId = remoteFiles.annotations?.[image.id]
    const file = (refId && annById.get(refId)) || annFiles.find((f) => f.name === `${image.id}.json`) || (await tryGet(client, refId))
    if (!file) {
      if (refId) {
        link.files.annotations[image.id] = refId // keep the reference so a push never duplicates it
        inaccessible.push(refId)
      }
      return
    }
    link.files.annotations[image.id] = file.id
    const path = `${ANNOTATIONS_DIR}/${file.name}`
    try {
      const doc = validateImageAnnotations(parseJson(await (await client.download(file.id)).text(), path), path)
      if (doc.imageId !== image.id) throw new SchemaError(`${path} belongs to another image`)
      annotations.set(image.id, { ...doc, projectId: remote.id })
      if (file.md5Checksum) link.remoteVersions[file.id] = file.md5Checksum
      if (doc.imageFingerprint !== image.fingerprint) warnings.push(`Annotations for "${image.name}" were made on a different version of the image.`)
    } catch (e) {
      if (e instanceof DriveError && (e.kind === 'not-found' || e.kind === 'forbidden')) inaccessible.push(file.id)
      else if (e instanceof SchemaError) warnings.push(`${path} is damaged and was skipped (${e.message}). It will not be overwritten unless you choose to.`)
      else throw e
    }
  })

  // Image sources: detect replaced or inaccessible Drive images.
  const visibleById = new Map(visibleImages.map((f) => [f.id, f]))
  const images: ImageRecord[] = await mapLimit(remote.images, 4, async (image) => {
    if (image.source.kind !== 'drive') {
      warnings.push(`"${image.name}" was never uploaded to Drive; its pixels are only on the device that added it.`)
      return image
    }
    let file = visibleById.get(image.source.fileId)
    if (!file) {
      try {
        file = await client.getFile(image.source.fileId)
      } catch (e) {
        if (e instanceof DriveError && (e.kind === 'not-found' || e.kind === 'forbidden')) {
          inaccessible.push(image.source.fileId)
          return image
        }
        throw e
      }
    }
    if (file.trashed) warnings.push(`The Drive image "${image.name}" is in the trash.`)
    return detectReplacement(image, file, now)
  })

  const referenced = new Set(images.flatMap((i) => (i.source.kind === 'drive' ? [i.source.fileId] : [])))
  const project = { ...remote, images, storage: link }
  return { folder, project, annotations, inaccessible: [...new Set(inaccessible)], unreferencedImages: visibleImages.filter((f) => !referenced.has(f.id)), warnings }
}

/**
 * Compare a Drive image's current md5 with the one recorded when it was imported.
 * A change means the file was replaced: flag it instead of silently re-using coordinates.
 */
export function detectReplacement(image: ImageRecord, file: DriveFile, now: () => string): ImageRecord {
  if (image.source.kind !== 'drive') return image
  const recorded = image.source.md5Checksum
  if (!recorded || !file.md5Checksum || recorded === file.md5Checksum) return image
  if (image.sourceMismatch?.remoteMd5 === file.md5Checksum) return image
  return {
    ...image,
    sourceMismatch: {
      detectedAt: now(),
      remoteMd5: file.md5Checksum,
      message: `The Drive file for "${image.name}" was replaced or edited after it was annotated. Existing marks may not line up with the new picture.`,
    },
  }
}

/** Download, validate and fingerprint a Drive image, producing a new ImageRecord. */
export async function importDriveImage(
  client: DriveClient,
  file: DriveFile,
  decode: ImageDecoder,
  now: () => string,
): Promise<{ record: ImageRecord; blob: Blob }> {
  const raw = await client.download(file.id)
  const info = await inspectImage(raw, decode)
  const blob = raw.type === info.mimeType ? raw : new Blob([raw], { type: info.mimeType })
  const record: ImageRecord = {
    id: newId(),
    name: file.name,
    imageGroupId: null,
    ...info,
    source: { kind: 'drive', fileId: file.id, md5Checksum: file.md5Checksum, version: file.version },
    addedAt: now(),
  }
  return { record, blob }
}

/** Fresh empty project bound to a Drive folder (folder without project.json). */
export function emptyDriveProject(folder: DriveFile, now: string, defaults: Pick<Project, 'annotationGroups'>): Project & { storage: DriveLink } {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: newId(),
    name: folder.name,
    createdAt: now,
    updatedAt: now,
    imageGroups: [],
    images: [],
    annotationGroups: defaults.annotationGroups,
    storage: newDriveLink(folder.id, folder.name),
    excludedDriveFileIds: [],
    revision: 0,
  }
}
