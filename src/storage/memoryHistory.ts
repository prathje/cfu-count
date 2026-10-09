/**
 * In-memory VersionHistory over a mutable project state: the demo repository's
 * history (nothing persists) and a realistic fake for editor tests. Same rules as
 * the IndexedDB history (counts, skip-if-unchanged, retention, restore) without
 * compression or deduplication.
 */
import type { ID, ImageAnnotations, Project } from '../model/types'
import { newId } from '../model/ids'
import type { VersionCreateResult, VersionHistory, VersionInfo, VersionReason } from './api'
import { buildRestoredState, computeCounts, planRetention, versionedProject, type RetentionPolicy } from './versions'
import { formatStamp } from './versionHistory'

export interface MemoryHistoryDeps {
  /** The saved working copy. */
  read(): { project: Project; docs: ImageAnnotations[] }
  /** Replace the working copy (restore). */
  write(project: Project, docs: ImageAnnotations[]): void
  now(): string
  retention?: RetentionPolicy
  /** Test hook: throw from create (e.g. a quota error). */
  failCreate?: () => unknown
}

interface Entry {
  info: VersionInfo
  project: Omit<Project, 'revision' | 'updatedAt'>
  docs: Map<ID, ImageAnnotations>
  json: string
}

export function createMemoryHistory(deps: MemoryHistoryDeps): VersionHistory & { readonly entries: readonly Entry[] } {
  let entries: Entry[] = []

  function create(reason: VersionReason, label: string): VersionCreateResult {
    const failure = deps.failCreate?.()
    if (failure) throw failure
    const { project, docs } = structuredClone(deps.read())
    const versioned = versionedProject(project)
    const json = JSON.stringify([versioned, docs])
    const latest = entries.at(-1)
    if ((reason === 'periodic' || reason === 'session-start') && latest?.json === json) return { version: latest.info, created: false }
    const info: VersionInfo = {
      id: newId(),
      projectId: project.id,
      createdAt: deps.now(),
      reason,
      label,
      counts: computeCounts(project, docs),
      storedBytes: json.length,
    }
    entries.push({ info, project: versioned, docs: new Map(docs.map((d) => [d.imageId, d])), json })
    const doomed = planRetention(entries.map((e) => e.info), Date.parse(deps.now()), deps.retention)
    if (doomed.size) entries = entries.filter((e) => !doomed.has(e.info.id))
    return { version: info, created: true }
  }

  const find = (id: ID): Entry => {
    const e = entries.find((x) => x.info.id === id)
    if (!e) throw new Error('This version no longer exists.')
    return e
  }

  return {
    get entries() {
      return entries
    },
    async list() {
      return entries.map((e) => e.info).reverse()
    },
    async create(reason, label) {
      return create(reason, label)
    },
    async load(id) {
      const e = find(id)
      return { project: structuredClone({ ...e.project, revision: 0, updatedAt: e.info.createdAt }) as Project, annotations: structuredClone(e.docs) }
    },
    async restore(id) {
      const e = find(id)
      const backup = create('before-restore', `Before restoring the version from ${formatStamp(new Date(e.info.createdAt))}`).version
      const current = deps.read()
      const restored = buildRestoredState(current, { project: e.project, docs: e.docs }, deps.now())
      restored.project.revision = current.project.revision + 1
      deps.write(restored.project, restored.docs)
      return {
        snapshot: { project: structuredClone(restored.project), annotations: new Map(restored.docs.map((d) => [d.imageId, structuredClone(d)])) },
        backup,
      }
    },
    async delete(id) {
      entries = entries.filter((e) => e.info.id !== id)
    },
  }
}
