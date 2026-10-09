/**
 * Project archive codec (.zip), same layout as a Drive project folder:
 *   project.json
 *   summary.csv
 *   annotations/<imageId>.json
 *   images/<imageId>.<ext>
 * Encoding is deterministic given its inputs; decoding validates everything and
 * never trusts file names beyond the documented layout.
 */
import { unzip, zip, type Zippable } from 'fflate'
import type { ID, ImageAnnotations, Project } from '../model/types'
import { buildSummaryCsv } from './csv'
import { encodeJson, toSharedProject, utf8 } from './documents'
import { SchemaError } from './errors'
import { extensionForMime, sha256Hex } from './images'
import { parseJson, validateImageAnnotations, validateProject } from './validate'

/** Inputs for one archive: the project, its annotation docs and the original image bytes. */
export interface ArchiveContents {
  project: Project
  annotations: Map<ID, ImageAnnotations>
  /** imageId -> original bytes. Images without bytes are listed in project.json only. */
  images: Map<ID, Blob>
}

/** Result of decoding: validated contents plus non-fatal warnings. */
export interface DecodedArchive extends ArchiveContents {
  warnings: string[]
}

/** Upper bound on total uncompressed size we are willing to inflate (zip-bomb guard). */
export const MAX_ARCHIVE_UNCOMPRESSED = 4 * 1024 ** 3

export async function encodeArchive(c: ArchiveContents): Promise<Uint8Array> {
  const files: Zippable = {
    'project.json': utf8.encode(encodeJson(toSharedProject(c.project))),
    'summary.csv': utf8.encode(buildSummaryCsv(c.project, c.annotations)),
  }
  for (const image of c.project.images) {
    const doc = c.annotations.get(image.id)
    // Export refreshes each document's group snapshot (project.json is the source of truth).
    if (doc) files[`annotations/${image.id}.json`] = utf8.encode(encodeJson({ ...doc, groups: c.project.annotationGroups }))
    const blob = c.images.get(image.id)
    if (blob) {
      // Already-compressed photo formats: store without deflate.
      files[`images/${image.id}.${extensionForMime(image.mimeType)}`] = [new Uint8Array(await blob.arrayBuffer()), { level: 0 }]
    }
  }
  return new Promise((resolve, reject) => zip(files, { level: 6 }, (err, data) => (err ? reject(err) : resolve(data))))
}

export async function decodeArchive(bytes: Uint8Array): Promise<DecodedArchive> {
  let total = 0
  const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) =>
    unzip(
      bytes,
      {
        filter: (f) => {
          total += f.originalSize
          if (total > MAX_ARCHIVE_UNCOMPRESSED) return false
          return f.name === 'project.json' || /^(annotations|images)\/[^/]+$/.test(f.name)
        },
      },
      (err, data) => (err ? reject(new SchemaError('The file is not a valid .zip archive.')) : resolve(data)),
    ),
  )
  if (total > MAX_ARCHIVE_UNCOMPRESSED) throw new SchemaError('The archive is too large to import.')
  const pj = entries['project.json']
  if (!pj) throw new SchemaError('The archive does not contain project.json — is it a colony counter project export?')
  const warnings: string[] = []
  const project = validateProject(parseJson(utf8.decode(pj), 'project.json'), 'project.json', warnings)
  const annotations = new Map<ID, ImageAnnotations>()
  const images = new Map<ID, Blob>()
  const imageFiles = new Map<string, string>() // imageId -> entry name
  for (const name of Object.keys(entries)) {
    const m = /^images\/([^/.]+)\.[^/]+$/.exec(name)
    if (m) imageFiles.set(m[1], name)
  }
  for (const image of project.images) {
    const annName = `annotations/${image.id}.json`
    if (entries[annName]) {
      const doc = validateImageAnnotations(parseJson(utf8.decode(entries[annName]), annName), annName)
      if (doc.imageId !== image.id) throw new SchemaError(`${annName} belongs to image ${doc.imageId}.`)
      if (doc.projectId !== project.id) warnings.push(`${annName} referred to another project ID; it was re-assigned.`)
      annotations.set(image.id, { ...doc, projectId: project.id })
      if (doc.imageFingerprint !== image.fingerprint || doc.width !== image.width || doc.height !== image.height) {
        warnings.push(`Annotations for "${image.name}" were made on a different version of the image.`)
      }
    }
    const imgName = imageFiles.get(image.id)
    if (imgName) {
      const data = entries[imgName]
      const fp = await sha256Hex(data)
      if (fp !== image.fingerprint) {
        warnings.push(`The image file for "${image.name}" does not match its recorded fingerprint.`)
      }
      images.set(image.id, new Blob([data as BlobPart], { type: image.mimeType }))
    } else if (image.source.kind === 'local') {
      warnings.push(`The archive has no image file for "${image.name}".`)
    }
  }
  const known = new Set(project.images.map((i) => i.id))
  const strays = Object.keys(entries).filter((n) => n.startsWith('annotations/') && !known.has(n.slice(12, -5)))
  if (strays.length) warnings.push(`${strays.length} annotation file(s) for images not in project.json were ignored.`)
  return { project, annotations, images, warnings }
}
