/** Pure presentation helpers for the Version history dialog (grouping, deltas, previews). */
import type { ID, ImageAnnotations, Project } from '../../model/types'
import { confirmedCount, confirmedCountsByGroup } from '../../model/annotations'
import { activeImages, displayOrder } from '../../model/project'
import type { ProjectSnapshot, VersionInfo, VersionReason } from '../../storage/api'
import { plural } from '../format'

export interface DayGroup {
  key: string
  title: string
  versions: VersionInfo[]
}

/** Versions (newest first) grouped by local day: "Today", "Yesterday", then "Mon 6 Oct". */
export function groupByDay(versions: readonly VersionInfo[], now = new Date()): DayGroup[] {
  const out: DayGroup[] = []
  const today = now.toDateString()
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).toDateString()
  for (const v of versions) {
    const d = new Date(v.createdAt)
    const key = d.toDateString()
    let group = out.at(-1)
    if (!group || group.key !== key) {
      const title =
        key === today
          ? 'Today'
          : key === yesterday
            ? 'Yesterday'
            : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) })
      out.push((group = { key, title, versions: [] }))
    }
    group.versions.push(v)
  }
  return out
}

export const versionTime = (v: Pick<VersionInfo, 'createdAt'>) => new Date(v.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

export function versionDateTime(v: Pick<VersionInfo, 'createdAt'>): string {
  const d = new Date(v.createdAt)
  return `${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}, ${versionTime(v)}`
}

/** Short tag shown next to a version. */
export function reasonTag(r: VersionReason): { text: string; tone: 'safety' | 'manual' | 'auto' } {
  switch (r) {
    case 'before-destructive':
      return { text: 'Before a change', tone: 'safety' }
    case 'before-restore':
      return { text: 'Before restoring', tone: 'safety' }
    case 'manual':
      return { text: 'Saved by you', tone: 'manual' }
    case 'session-start':
      return { text: 'Opened', tone: 'auto' }
    case 'periodic':
      return { text: 'Automatic', tone: 'auto' }
  }
}

/** "312 more than now" / "12 fewer than now" / "same as now". */
export function deltaText(version: number, now: number): string {
  const d = version - now
  if (d === 0) return 'same as now'
  return `${Math.abs(d).toLocaleString()} ${d > 0 ? 'more' : 'fewer'} than now`
}

export interface CurrentCounts {
  annotations: number
  images: number
  byGroup: Map<ID, number>
}

/** Confirmed counts of the open project (same rules as a version's counts). */
export function currentCounts(project: Project, docs: Record<ID, ImageAnnotations>): CurrentCounts {
  const byGroup = new Map<ID, number>()
  let annotations = 0
  const images = activeImages(project)
  for (const img of images) {
    for (const [g, n] of confirmedCountsByGroup(docs[img.id]?.annotations)) {
      byGroup.set(g, (byGroup.get(g) ?? 0) + n)
      annotations += n
    }
  }
  return { annotations, images: images.length, byGroup }
}

export interface GroupRow {
  id: ID
  name: string
  color: string
  version: number
  now: number
  /** Only in the version (deleted since) or only now (created since). */
  status: 'both' | 'version-only' | 'now-only'
}

/** Per-group comparison rows: the version's groups in its order, then groups created since. */
export function groupRows(version: VersionInfo, project: Project, now: CurrentCounts): GroupRow[] {
  const rows: GroupRow[] = version.counts.groups.map((g) => ({
    id: g.id,
    name: g.name,
    color: g.color,
    version: g.count,
    now: now.byGroup.get(g.id) ?? 0,
    status: project.annotationGroups.some((x) => x.id === g.id) ? 'both' : 'version-only',
  }))
  for (const g of project.annotationGroups) {
    if (!rows.some((r) => r.id === g.id)) rows.push({ id: g.id, name: g.name, color: g.color, version: 0, now: now.byGroup.get(g.id) ?? 0, status: 'now-only' })
  }
  return rows
}

export interface ImageRow {
  id: ID
  name: string
  version: number
  now: number
  /** The image is not in the version (added later): restoring the version moves it to Recently removed. */
  addedLater: boolean
  /** Stored annotations differ (even when the confirmed counts match). */
  changed: boolean
}

/**
 * Per-image comparison of a loaded version with the open project, in the project's
 * display order. Images removed now but present in the version are included (restoring
 * brings them back).
 */
export function imageRows(snapshot: ProjectSnapshot, project: Project, docs: Record<ID, ImageAnnotations>): ImageRow[] {
  const inVersion = new Map(snapshot.project.images.filter((i) => !i.deletedAt).map((i) => [i.id, i]))
  const order = displayOrder(project)
  const seen = new Set(order.map((i) => i.id))
  const removedNow = [...inVersion.values()].filter((i) => !seen.has(i.id))
  const rows: ImageRow[] = []
  for (const img of [...order, ...removedNow]) {
    const versionDoc = snapshot.annotations.get(img.id)
    const nowDoc = docs[img.id]
    const a = versionDoc?.annotations ?? []
    const b = nowDoc?.annotations ?? []
    rows.push({
      id: img.id,
      name: project.images.find((i) => i.id === img.id)?.name ?? img.name,
      version: inVersion.has(img.id) ? confirmedCount(a) : 0,
      now: seen.has(img.id) ? confirmedCount(b) : 0,
      addedLater: !snapshot.project.images.some((i) => i.id === img.id),
      changed: JSON.stringify(a) !== JSON.stringify(b),
    })
  }
  return rows
}

/** One-line summary of what restoring a version changes (for the confirmation). */
export function restoreSummary(rows: readonly ImageRow[]): string {
  const changed = rows.filter((r) => r.changed && !r.addedLater).length
  const later = rows.filter((r) => r.addedLater).length
  const parts = [changed ? `Annotations change on ${plural(changed, 'image')}` : 'No annotations change']
  if (later) parts.push(`${plural(later, 'image')} added later ${later === 1 ? 'moves' : 'move'} to Recently removed (nothing is erased)`)
  return parts.join('; ') + '.'
}
