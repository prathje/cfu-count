/**
 * Ground truth from a project export (.zip, layout in src/storage/archive.ts):
 *   project.json, annotations/<imageId>.json, images/<imageId>.<ext>
 *
 * GT points are the CONFIRMED annotations of an image (all groups, or one
 * group by name/id). Images are matched to local files by name or by SHA-256
 * fingerprint; image bytes inside the zip are used when present.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { unzipSync } from 'fflate'
import type { Annotation, AnnotationGroup, ImageAnnotations, Project } from '../../src/model/types.ts'

export interface GtImage {
  imageId: string
  name: string
  fingerprint: string
  width: number
  height: number
  /** Image bytes from the zip, if included. */
  bytes?: Uint8Array
  points: { id: string; x: number; y: number; groupId: string; origin: Annotation['origin']; r?: number }[]
  groups: AnnotationGroup[]
}

export function loadGtZip(path: string, groupFilter?: string): GtImage[] {
  const entries = unzipSync(readFileSync(path))
  const pj = entries['project.json']
  if (!pj) throw new Error(`${path}: no project.json (not a project export?)`)
  const project = JSON.parse(new TextDecoder().decode(pj)) as Project
  const out: GtImage[] = []
  for (const img of project.images) {
    const docBytes = entries[`annotations/${img.id}.json`]
    if (!docBytes) continue
    const doc = JSON.parse(new TextDecoder().decode(docBytes)) as ImageAnnotations
    const groups = project.annotationGroups
    const gid = groupFilter ? groups.find((g) => g.id === groupFilter || g.name === groupFilter)?.id : undefined
    if (groupFilter && !gid) throw new Error(`group "${groupFilter}" not found in ${path}`)
    const points = doc.annotations
      .filter((a) => a.reviewStatus === 'accepted' && (!gid || a.groupId === gid))
      .map((a) => ({ id: a.id, x: a.x, y: a.y, groupId: a.groupId, origin: a.origin, r: a.geometry?.r }))
    const imageEntry = Object.keys(entries).find((k) => k.startsWith(`images/${img.id}.`))
    out.push({ imageId: img.id, name: img.name, fingerprint: img.fingerprint, width: img.width, height: img.height, bytes: imageEntry ? entries[imageEntry] : undefined, points, groups })
  }
  return out
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Find the GT record for a local image file: by fingerprint first, then by name. */
export function findGt(gt: GtImage[], fileName: string, bytes: Uint8Array): GtImage | undefined {
  const fp = sha256Hex(bytes)
  return gt.find((g) => g.fingerprint === fp) ?? gt.find((g) => g.name === fileName || g.name.replace(/\.[^.]+$/, '') === fileName.replace(/\.[^.]+$/, ''))
}
