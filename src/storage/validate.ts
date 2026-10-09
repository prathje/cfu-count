/**
 * Runtime validation of schema-v1 documents read from untrusted sources
 * (Drive folders, imported archives). Throws SchemaError with a JSON path.
 * Unknown extra fields are preserved (forward-compatible), missing required
 * fields are errors.
 */
import { SCHEMA_VERSION } from '../model/types'
import type {
  Annotation,
  AnnotationGroup,
  DetectionRun,
  ImageAnnotations,
  ImageGroup,
  ImageRecord,
  Project,
  ProjectStorageLink,
} from '../model/types'
import { SchemaError } from './errors'

type Obj = Record<string, unknown>

/** Default label font size (CSS px) for groups saved before `labelSize` existed. */
export const DEFAULT_LABEL_SIZE = 12

function fail(path: string, what: string): never {
  throw new SchemaError(`Invalid ${path}: ${what}`)
}
function obj(v: unknown, path: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(path, 'expected an object')
  return v as Obj
}
function str(o: Obj, k: string, path: string): string {
  const v = o[k]
  if (typeof v !== 'string') fail(`${path}.${k}`, 'expected a string')
  return v
}
function optStr(o: Obj, k: string, path: string): void {
  if (o[k] !== undefined && typeof o[k] !== 'string') fail(`${path}.${k}`, 'expected a string')
}
function num(o: Obj, k: string, path: string): number {
  const v = o[k]
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${path}.${k}`, 'expected a finite number')
  return v
}
function bool(o: Obj, k: string, path: string): boolean {
  const v = o[k]
  if (typeof v !== 'boolean') fail(`${path}.${k}`, 'expected true/false')
  return v
}
function arr(o: Obj, k: string, path: string): unknown[] {
  const v = o[k]
  if (!Array.isArray(v)) fail(`${path}.${k}`, 'expected an array')
  return v
}
function oneOf<T extends string>(o: Obj, k: string, values: readonly T[], path: string): T {
  const v = o[k]
  if (typeof v !== 'string' || !values.includes(v as T)) fail(`${path}.${k}`, `expected one of ${values.join(', ')}`)
  return v as T
}

function checkSchemaVersion(o: Obj, path: string): void {
  const v = o.schemaVersion
  if (typeof v !== 'number') fail(`${path}.schemaVersion`, 'missing')
  if (v > SCHEMA_VERSION) {
    throw new SchemaError(`${path} was written by a newer version of the app (schema ${v}); please update the app.`)
  }
  if (v !== SCHEMA_VERSION) fail(`${path}.schemaVersion`, `unsupported version ${v}`)
}

function uniqueIds(items: { id: string }[], path: string): void {
  const seen = new Set<string>()
  for (const it of items) {
    if (seen.has(it.id)) fail(path, `duplicate id ${it.id}`)
    seen.add(it.id)
  }
}

export function validateAnnotationGroup(v: unknown, path: string): AnnotationGroup {
  const o = obj(v, path)
  str(o, 'id', path)
  str(o, 'name', path)
  str(o, 'color', path)
  oneOf(o, 'render', ['dot', 'circle'] as const, path)
  const opacity = num(o, 'opacity', path)
  if (opacity < 0 || opacity > 1) fail(`${path}.opacity`, 'must be between 0 and 1')
  if (num(o, 'size', path) <= 0) fail(`${path}.size`, 'must be positive')
  bool(o, 'labels', path)
  if (o.labelSize === undefined) o.labelSize = DEFAULT_LABEL_SIZE
  if (num(o, 'labelSize', path) <= 0) fail(`${path}.labelSize`, 'must be positive')
  bool(o, 'hidden', path)
  bool(o, 'locked', path)
  return o as unknown as AnnotationGroup
}

function validateImageGroup(v: unknown, path: string): ImageGroup {
  const o = obj(v, path)
  str(o, 'id', path)
  str(o, 'name', path)
  return o as unknown as ImageGroup
}

function validateImage(v: unknown, path: string): ImageRecord {
  const o = obj(v, path)
  str(o, 'id', path)
  str(o, 'name', path)
  if (o.imageGroupId !== null && typeof o.imageGroupId !== 'string') fail(`${path}.imageGroupId`, 'expected a string or null')
  if (num(o, 'width', path) <= 0 || num(o, 'height', path) <= 0) fail(path, 'width/height must be positive')
  str(o, 'mimeType', path)
  num(o, 'byteSize', path)
  str(o, 'fingerprint', path)
  str(o, 'addedAt', path)
  optStr(o, 'sampleId', path)
  const src = obj(o.source, `${path}.source`)
  const kind = oneOf(src, 'kind', ['local', 'drive'] as const, `${path}.source`)
  if (kind === 'drive') {
    str(src, 'fileId', `${path}.source`)
    optStr(src, 'version', `${path}.source`)
    optStr(src, 'md5Checksum', `${path}.source`)
  }
  return o as unknown as ImageRecord
}

function validateStorage(v: unknown, path: string): ProjectStorageLink {
  const o = obj(v, path)
  const kind = oneOf(o, 'kind', ['local', 'drive'] as const, path)
  if (kind === 'drive') {
    str(o, 'folderId', path)
    str(o, 'folderName', path)
    const files = obj(o.files, `${path}.files`)
    for (const k of ['projectJson', 'summaryCsv', 'annotationsFolder', 'imagesFolder']) optStr(files, k, `${path}.files`)
    const ann = obj(files.annotations ?? {}, `${path}.files.annotations`)
    for (const [k, id] of Object.entries(ann)) if (typeof id !== 'string') fail(`${path}.files.annotations.${k}`, 'expected a string')
    files.annotations = ann
    o.remoteVersions = obj(o.remoteVersions ?? {}, `${path}.remoteVersions`)
  }
  return o as unknown as ProjectStorageLink
}

export function validateProject(v: unknown, path = 'project.json'): Project {
  const o = obj(v, path)
  checkSchemaVersion(o, path)
  str(o, 'id', path)
  str(o, 'name', path)
  str(o, 'createdAt', path)
  str(o, 'updatedAt', path)
  const imageGroups = arr(o, 'imageGroups', path).map((g, i) => validateImageGroup(g, `${path}.imageGroups[${i}]`))
  const images = arr(o, 'images', path).map((g, i) => validateImage(g, `${path}.images[${i}]`))
  const groups = arr(o, 'annotationGroups', path).map((g, i) => validateAnnotationGroup(g, `${path}.annotationGroups[${i}]`))
  uniqueIds(imageGroups, `${path}.imageGroups`)
  uniqueIds(images, `${path}.images`)
  uniqueIds(groups, `${path}.annotationGroups`)
  const groupIds = new Set(imageGroups.map((g) => g.id))
  images.forEach((im, i) => {
    if (im.imageGroupId !== null && !groupIds.has(im.imageGroupId)) {
      fail(`${path}.images[${i}].imageGroupId`, `unknown image group ${im.imageGroupId}`)
    }
  })
  o.storage = validateStorage(o.storage ?? { kind: 'local' }, `${path}.storage`)
  if (o.revision === undefined) o.revision = 0
  num(o, 'revision', path)
  return o as unknown as Project
}

function optNum(o: Obj, k: string, path: string): void {
  if (o[k] !== undefined) num(o, k, path)
}

function validateGeometry(v: unknown, path: string): void {
  const o = obj(v, path)
  oneOf(o, 'kind', ['circle'] as const, path)
  if (num(o, 'r', path) <= 0) fail(`${path}.r`, 'must be positive')
  optNum(o, 'quality', path)
  oneOf(o, 'source', ['fit', 'seed-estimate'] as const, path)
}

function validateSeed(v: unknown, path: string): void {
  const o = obj(v, path)
  str(o, 'annotationId', path)
  str(o, 'imageId', path)
  num(o, 'x', path)
  num(o, 'y', path)
  if (o.radiusPx !== null) num(o, 'radiusPx', path)
  oneOf(o, 'quality', ['ok', 'touching', 'edge', 'glare', 'weak'] as const, path)
}

function validateDetectionRun(v: unknown, path: string): DetectionRun {
  const o = obj(v, path)
  for (const k of ['runId', 'method', 'version', 'createdAt', 'imageFingerprint', 'targetGroupId']) str(o, k, path)
  if (num(o, 'analysisScale', path) <= 0) fail(`${path}.analysisScale`, 'must be positive')
  arr(o, 'seeds', path).forEach((sd, i) => validateSeed(sd, `${path}.seeds[${i}]`))
  obj(o.prior, `${path}.prior`)
  obj(o.settings, `${path}.settings`)
  if (o.seedImageFingerprints !== undefined) {
    const m = obj(o.seedImageFingerprints, `${path}.seedImageFingerprints`)
    for (const [k, fp] of Object.entries(m)) if (typeof fp !== 'string') fail(`${path}.seedImageFingerprints.${k}`, 'expected a string')
  }
  if (o.roi !== undefined) {
    const r = obj(o.roi, `${path}.roi`)
    const kind = oneOf(r, 'kind', ['circle', 'rect'] as const, `${path}.roi`)
    for (const k of kind === 'circle' ? ['cx', 'cy', 'r'] : ['x', 'y', 'w', 'h']) num(r, k, `${path}.roi`)
  }
  if (o.negatives !== undefined) {
    arr(o, 'negatives', path).forEach((n, i) => {
      const q = obj(n, `${path}.negatives[${i}]`)
      num(q, 'x', `${path}.negatives[${i}]`)
      num(q, 'y', `${path}.negatives[${i}]`)
    })
  }
  if (o.diagnostics !== undefined) obj(o.diagnostics, `${path}.diagnostics`)
  return o as unknown as DetectionRun
}

function validateAnnotation(v: unknown, path: string): Annotation {
  const o = obj(v, path)
  str(o, 'id', path)
  num(o, 'x', path)
  num(o, 'y', path)
  str(o, 'groupId', path)
  oneOf(o, 'origin', ['manual', 'automated'] as const, path)
  str(o, 'createdAt', path)
  str(o, 'updatedAt', path)
  oneOf(o, 'reviewStatus', ['unreviewed', 'accepted', 'rejected'] as const, path)
  optStr(o, 'reviewedAt', path)
  oneOf(o, 'lastEditSource', ['manual', 'automated'] as const, path)
  bool(o, 'manuallyAdjusted', path)
  if (o.detector !== undefined) {
    const d = obj(o.detector, `${path}.detector`)
    str(d, 'name', `${path}.detector`)
    str(d, 'version', `${path}.detector`)
    str(d, 'runId', `${path}.detector`)
    if (d.confidence !== null) num(d, 'confidence', `${path}.detector`)
  }
  if (o.geometry !== undefined) validateGeometry(o.geometry, `${path}.geometry`)
  return o as unknown as Annotation
}

export function validateImageAnnotations(v: unknown, path = 'annotations'): ImageAnnotations {
  const o = obj(v, path)
  checkSchemaVersion(o, path)
  str(o, 'projectId', path)
  str(o, 'imageId', path)
  str(o, 'imageFingerprint', path)
  num(o, 'width', path)
  num(o, 'height', path)
  str(o, 'updatedAt', path)
  const groups = arr(o, 'groups', path).map((g, i) => validateAnnotationGroup(g, `${path}.groups[${i}]`))
  const anns = arr(o, 'annotations', path).map((a, i) => validateAnnotation(a, `${path}.annotations[${i}]`))
  uniqueIds(groups, `${path}.groups`)
  uniqueIds(anns, `${path}.annotations`)
  if (o.detectionRuns === undefined) o.detectionRuns = []
  const runs = arr(o, 'detectionRuns', path).map((r, i) => validateDetectionRun(r, `${path}.detectionRuns[${i}]`))
  uniqueIds(runs.map((r) => ({ id: r.runId })), `${path}.detectionRuns`)
  return o as unknown as ImageAnnotations
}

/** Parse JSON text, converting syntax errors into SchemaError. */
export function parseJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new SchemaError(`${path} is not valid JSON.`)
  }
}
