/**
 * Version history: pure rules shared by the IndexedDB history (versionHistory.ts)
 * and the in-memory demo repository. No I/O, no framework.
 *
 *   computeCounts      the counts a version shows (confirmed marks, per group, images)
 *   encode / decode    compact payloads: JSON deflated with fflate (~5x smaller)
 *   contentKey         content hash used to store each unchanged document only once
 *   planRetention      which versions to keep (fixed clock, pure)
 *   buildRestoredState the working copy after restoring a version
 */
import { deflateSync, inflateSync, strFromU8, strToU8 } from 'fflate'
import type { ID, ImageAnnotations, Project } from '../model/types'
import { confirmedCountsByGroup } from '../model/annotations'
import { activeImages, applyStorageOwned, emptyDoc } from '../model/project'
import type { VersionCounts, VersionReason } from './api'

// ------------------------------------------------------------------ counts

/** Confirmed annotations on images that are part of the project (removed images excluded), per group. */
export function computeCounts(project: Project, docs: Iterable<ImageAnnotations>): VersionCounts {
  const active = new Set(activeImages(project).map((i) => i.id))
  const perGroup = new Map<ID, number>()
  for (const doc of docs) {
    if (!active.has(doc.imageId)) continue
    for (const [g, n] of confirmedCountsByGroup(doc.annotations)) perGroup.set(g, (perGroup.get(g) ?? 0) + n)
  }
  const groups = project.annotationGroups.map((g) => ({ id: g.id, name: g.name, color: g.color, count: perGroup.get(g.id) ?? 0 }))
  // Marks of groups that no longer exist still count (they are restored with the version).
  let annotations = 0
  for (const n of perGroup.values()) annotations += n
  return { annotations, images: active.size, groups }
}

// ------------------------------------------------------------------ payloads

/** Encode a JSON string compactly: UTF-8, deflated (annotation documents shrink ~5x). */
export function encodeJson(json: string): { data: Uint8Array; rawBytes: number } {
  const raw = strToU8(json)
  return { data: deflateSync(raw, { level: 6 }), rawBytes: raw.length }
}

export function decodePayload<T>(data: Uint8Array): T {
  return JSON.parse(strFromU8(inflateSync(data))) as T
}

/**
 * Content hash of a JSON string: two independent 53-bit cyrb53 hashes plus the
 * length (no crypto.subtle: it is missing on plain-http LAN dev servers). Used only
 * to share identical documents between versions; a collision would need ~2^53 docs.
 */
export function contentKey(json: string): string {
  return `${cyrb53(json, 0x9e3779b9).toString(36)}-${cyrb53(json, 0x85ebca6b).toString(36)}-${json.length.toString(36)}`
}

function cyrb53(str: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

/**
 * The parts of project.json a version stores. `revision` and `updatedAt` change on
 * every save, so they are left out: an otherwise unchanged project is stored once.
 * Storage-owned fields are taken from the working copy on restore anyway.
 */
export function versionedProject(project: Project): Omit<Project, 'revision' | 'updatedAt'> {
  const { revision: _r, updatedAt: _u, ...rest } = project
  return rest
}

// ------------------------------------------------------------------ retention

export interface RetentionPolicy {
  /** Keep every version younger than this. */
  keepAllMs: number
  /** Then the newest version per hour up to this age. */
  hourlyUntilMs: number
  /** Then the newest version per day up to this age; older ones are dropped. */
  dailyUntilMs: number
  /** Hard cap on the number of versions per project. */
  max: number
  /** The newest N versions are always kept, whatever their age (an idle project keeps its last states). */
  keepNewest: number
  /** The most recent safety version (before a destructive change or a restore) is kept this long. */
  protectSafetyMs: number
}

const HOUR = 3_600_000
const DAY = 24 * HOUR

export const DEFAULT_RETENTION: RetentionPolicy = {
  keepAllMs: DAY,
  hourlyUntilMs: 7 * DAY,
  dailyUntilMs: 30 * DAY,
  max: 200,
  keepNewest: 3,
  protectSafetyMs: 7 * DAY,
}

export interface RetentionItem {
  id: ID
  createdAt: string
  reason: VersionReason
}

/** Versions taken right before something replaced or removed data. */
export const isSafetyReason = (r: VersionReason): boolean => r === 'before-destructive' || r === 'before-restore'

/** Priority within an hour/day bucket: safety and manual versions win over automatic ones. */
const bucketRank = (r: VersionReason): number => (isSafetyReason(r) ? 2 : r === 'manual' ? 1 : 0)

/**
 * Ids of the versions to delete. Rules, in order:
 *  - younger than 24 h: keep all;
 *  - 24 h – 7 d: keep one per clock hour; 7 d – 30 d: one per day (safety, then
 *    manual, then newest wins inside a bucket); older: drop;
 *  - always keep the newest `keepNewest` and the most recent safety version younger than 7 d;
 *  - above `max`, drop the oldest unprotected versions.
 */
export function planRetention(items: readonly RetentionItem[], nowMs: number, policy: RetentionPolicy = DEFAULT_RETENTION): Set<ID> {
  const sorted = [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) // newest first
  const protectedIds = new Set(sorted.slice(0, policy.keepNewest).map((v) => v.id))
  const safety = sorted.find((v) => isSafetyReason(v.reason) && nowMs - Date.parse(v.createdAt) < policy.protectSafetyMs)
  if (safety) protectedIds.add(safety.id)

  const keep = new Set<ID>()
  const buckets = new Map<string, RetentionItem>()
  for (const v of sorted) {
    const age = nowMs - Date.parse(v.createdAt)
    if (age < policy.keepAllMs) {
      keep.add(v.id)
      continue
    }
    let bucket: string
    if (age < policy.hourlyUntilMs) bucket = `h${Math.floor(Date.parse(v.createdAt) / HOUR)}`
    else if (age < policy.dailyUntilMs) bucket = `d${Math.floor(Date.parse(v.createdAt) / DAY)}`
    else continue
    const best = buckets.get(bucket)
    // Newest first, so a later candidate replaces the current best only with a higher rank.
    if (!best || bucketRank(v.reason) > bucketRank(best.reason)) buckets.set(bucket, v)
  }
  for (const v of buckets.values()) keep.add(v.id)
  for (const id of protectedIds) keep.add(id)

  // Cap: drop the oldest kept versions that are not protected.
  const kept = sorted.filter((v) => keep.has(v.id))
  for (let i = kept.length - 1; i >= 0 && keep.size > policy.max; i--) {
    if (!protectedIds.has(kept[i].id)) keep.delete(kept[i].id)
  }
  return new Set(sorted.filter((v) => !keep.has(v.id)).map((v) => v.id))
}

/**
 * Versions to delete to free space after a quota error: the oldest automatic
 * versions first (at least one, about a quarter of them), never protected ones.
 */
export function planQuotaRelief(items: readonly RetentionItem[], nowMs: number, policy: RetentionPolicy = DEFAULT_RETENTION): ID[] {
  const sorted = [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const protectedIds = new Set(sorted.slice(0, 1).map((v) => v.id))
  const safety = sorted.find((v) => isSafetyReason(v.reason) && nowMs - Date.parse(v.createdAt) < policy.protectSafetyMs)
  if (safety) protectedIds.add(safety.id)
  const automatic = sorted.filter((v) => (v.reason === 'periodic' || v.reason === 'session-start') && !protectedIds.has(v.id)).reverse()
  const pick = automatic.length ? automatic : sorted.filter((v) => !protectedIds.has(v.id)).reverse()
  return pick.slice(0, Math.max(1, Math.ceil(pick.length / 4))).map((v) => v.id)
}

// ------------------------------------------------------------------ restore

export interface RestoredState {
  project: Project
  /** Every annotation document of the restored project (replaces all stored docs). */
  docs: ImageAnnotations[]
  /** Images added after the version, now in "Recently removed" (soft delete, nothing erased). */
  removedLater: ID[]
}

/**
 * The working copy after restoring `version` over `current`:
 *  - editor-owned data (name, groups, images, annotations) comes from the version;
 *  - storage-owned fields (storage link, revision, image sources) stay as they are now;
 *  - images added after the version are kept but soft-deleted, with their documents,
 *    so nothing is erased and they can be restored from "Recently removed";
 *  - an image without a document in the version gets an empty one (its marks are gone
 *    in that version), so a Drive-linked project uploads the emptied file.
 */
export function buildRestoredState(
  current: { project: Project; docs: readonly ImageAnnotations[] },
  version: { project: Omit<Project, 'revision' | 'updatedAt'> & Partial<Pick<Project, 'revision' | 'updatedAt'>>; docs: ReadonlyMap<ID, ImageAnnotations> },
  at: string,
): RestoredState {
  const base: Project = { ...structuredClone(version.project), id: current.project.id, revision: current.project.revision, updatedAt: at } as Project
  const merged = applyStorageOwned(base, current.project)
  const inVersion = new Set(merged.images.map((i) => i.id))
  const removedLater: ID[] = []
  const later = current.project.images
    .filter((i) => !inVersion.has(i.id))
    .map((i) => {
      if (i.deletedAt) return structuredClone(i)
      removedLater.push(i.id)
      return { ...structuredClone(i), deletedAt: at }
    })
  const project: Project = { ...merged, images: [...merged.images, ...later] }

  const currentDocs = new Map(current.docs.map((d) => [d.imageId, d]))
  const docs: ImageAnnotations[] = []
  for (const image of merged.images) {
    const fromVersion = version.docs.get(image.id)
    if (fromVersion) docs.push({ ...structuredClone(fromVersion), projectId: project.id, detectionRuns: fromVersion.detectionRuns ?? [] })
    else if (currentDocs.has(image.id)) docs.push(emptyDoc(project, image, at))
  }
  for (const image of later) {
    const d = currentDocs.get(image.id)
    if (d) docs.push(structuredClone(d))
  }
  return { project, docs, removedLater }
}
