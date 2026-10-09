/**
 * In-memory ProjectRepository used ONLY while the real storage implementation
 * is unavailable (see repository.ts). Nothing persists across reloads, and the
 * Drive methods are simulated only when the page is opened with ?fakeDrive=1
 * (or ?fakeDrive=conflict) so the Drive UI can be exercised. The UI shows a
 * visible "demo storage" badge whenever this repository is active.
 */
import { createSignal } from 'solid-js'
import { strToU8, unzipSync, zipSync, strFromU8 } from 'fflate'
import type { ID, ImageAnnotations, ImageRecord, Project } from '../model/types'
import { SCHEMA_VERSION } from '../model/types'
import { newId, now } from '../model/ids'
import type { DriveState, ImportResult, OpenedProject, ProjectRepository, ProjectSummary, SaveStatus } from '../storage/api'
import { confirmedCountsByGroup, makeManualAnnotation } from '../model/annotations'
import { makeGroup } from '../model/groups'
import { drawSamplePlate } from './sampleImages'

interface Stored {
  project: Project
  annotations: Map<ID, ImageAnnotations>
  blobs: Map<ID, Blob>
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
const clone = <T>(v: T): T => structuredClone(v)

async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function blankProject(name: string): Project {
  const at = now()
  return {
    schemaVersion: SCHEMA_VERSION,
    id: newId(),
    name,
    createdAt: at,
    updatedAt: at,
    imageGroups: [],
    images: [],
    annotationGroups: [],
    storage: { kind: 'local' },
    excludedDriveFileIds: [],
    revision: 0,
  }
}

export function createFakeRepository(): ProjectRepository {
  const params = new URLSearchParams(globalThis.location?.search ?? '')
  const driveMode = params.get('fakeDrive') // null | '1' | 'conflict'
  const [status, setStatus] = createSignal<SaveStatus>({ state: 'idle' })
  const [drive, setDrive] = createSignal<DriveState>(driveMode ? { state: 'disconnected' } : { state: 'unconfigured' })
  const store = new Map<ID, Stored>()
  let seeded: Promise<void> | null = null
  let openId: ID | null = null
  let driveTimer: ReturnType<typeof setTimeout> | null = null
  const listeners = new Set<(project: Project) => void>()
  const emitProject = (s: Stored) => listeners.forEach((l) => l(clone(s.project)))

  const get = (id: ID): Stored => {
    const s = store.get(id)
    if (!s) throw new Error('Project not found in this browser.')
    return s
  }
  const opened = (s: Stored): OpenedProject => ({ project: clone(s.project), annotations: new Map(clone([...s.annotations])) })
  const markOpen = (s: Stored) => {
    openId = s.project.id
    setStatus({ state: 'saved-local', at: s.project.updatedAt })
  }

  function seed(): Promise<void> {
    seeded ??= (async () => {
      const project = blankProject('Demo — E. coli dilution series')
      const main = makeGroup([], newId(), 'Colonies')
      const small = makeGroup([main], newId(), 'Small colonies')
      small.render = 'circle'
      project.annotationGroups = [main, small]
      const groupA = { id: newId(), name: 'Treatment A' }
      const groupB = { id: newId(), name: 'Control' }
      project.imageGroups = [groupA, groupB]
      const s: Stored = { project, annotations: new Map(), blobs: new Map() }
      const plates = [
        { seed: 11, name: 'plate_A_10-4.jpg', count: 64, tint: 'cream' as const, group: groupA.id, annotate: 40 },
        { seed: 23, name: 'plate_A_10-5.jpg', count: 18, tint: 'cream' as const, group: groupA.id, annotate: 0 },
        { seed: 37, name: 'control_blood_agar.jpg', count: 120, tint: 'red' as const, group: groupB.id, annotate: 0 },
        { seed: 51, name: 'unsorted_plate.jpg', count: 35, tint: 'amber' as const, group: null, annotate: 0 },
      ]
      for (const p of plates) {
        const plate = await drawSamplePlate(p.seed, p.name, p.count, p.tint)
        const record: ImageRecord = {
          id: newId(),
          name: p.name,
          imageGroupId: p.group,
          width: plate.width,
          height: plate.height,
          mimeType: 'image/jpeg',
          byteSize: plate.blob.size,
          fingerprint: await sha256(plate.blob),
          source: { kind: 'local' },
          addedAt: now(),
        }
        project.images.push(record)
        s.blobs.set(record.id, plate.blob)
        if (p.annotate) {
          const at = now()
          s.annotations.set(record.id, {
            schemaVersion: SCHEMA_VERSION,
            projectId: project.id,
            imageId: record.id,
            imageFingerprint: record.fingerprint,
            width: record.width,
            height: record.height,
            groups: clone(project.annotationGroups),
            annotations: plate.colonies
              .slice(0, p.annotate)
              .map((c, i) => makeManualAnnotation(c.x, c.y, i % 6 === 5 ? small.id : main.id, newId(), at)),
            detectionRuns: [],
            updatedAt: at,
          })
        }
      }
      store.set(project.id, s)
    })()
    return seeded
  }

  function scheduleDriveSave(id: ID) {
    if (driveTimer) clearTimeout(driveTimer)
    driveTimer = setTimeout(() => {
      if (drive().state === 'connected') void repo.saveToDrive(id).catch(() => {})
    }, 2500)
  }

  const requireDrive = () => {
    if (!driveMode) throw new Error('Google Drive is not configured in this build.')
    if (drive().state !== 'connected') throw new Error('Connect Google Drive first.')
  }

  const repo: ProjectRepository = {
    status,
    drive,

    async listProjects(): Promise<ProjectSummary[]> {
      await seed()
      return [...store.values()].map(({ project }) => ({
        id: project.id,
        name: project.name,
        updatedAt: project.updatedAt,
        imageCount: project.images.length,
        storage: project.storage.kind,
        driveFolderName: project.storage.kind === 'drive' ? project.storage.folderName : undefined,
      }))
    },

    async createProject(name) {
      await delay(120)
      const s: Stored = { project: blankProject(name), annotations: new Map(), blobs: new Map() }
      store.set(s.project.id, s)
      markOpen(s)
      return opened(s)
    },

    async openProject(id) {
      await seed()
      await delay(80)
      const s = get(id)
      markOpen(s)
      return opened(s)
    },

    async deleteProject(id) {
      store.delete(id)
      if (openId === id) {
        openId = null
        setStatus({ state: 'idle' })
      }
    },

    onProjectUpdated(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    async saveLocal(project, annotations) {
      await delay(60)
      const s = store.get(project.id) ?? { project, annotations: new Map(), blobs: new Map() }
      // Storage owns storage link + revision (see contract).
      s.project = clone({ ...project, storage: s.project.storage, revision: (s.project.revision ?? 0) + 1 })
      for (const doc of annotations) s.annotations.set(doc.imageId, clone(doc))
      store.set(project.id, s)
      if (s.project.storage.kind === 'drive') {
        setStatus({ state: 'pending' })
        scheduleDriveSave(project.id)
      } else {
        setStatus({ state: 'saved-local', at: now() })
      }
    },

    async importImageFiles(project, files): Promise<ImportResult> {
      const s = get(project.id)
      const result: ImportResult = { added: [], rejected: [] }
      for (const file of files) {
        if (!/^image\/(jpeg|png|webp|gif|bmp|avif)$/.test(file.type)) {
          result.rejected.push({ name: file.name, reason: `Unsupported format (${file.type || 'unknown type'}). Use JPEG, PNG or WebP.` })
          continue
        }
        try {
          const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
          const record: ImageRecord = {
            id: newId(),
            name: file.name,
            imageGroupId: null,
            width: bitmap.width,
            height: bitmap.height,
            mimeType: file.type,
            byteSize: file.size,
            fingerprint: await sha256(file),
            source: { kind: 'local' },
            addedAt: now(),
          }
          bitmap.close()
          s.blobs.set(record.id, file)
          result.added.push(record)
        } catch {
          result.rejected.push({ name: file.name, reason: 'The browser could not decode this image.' })
        }
      }
      return result
    },

    async getImageBlob(project, imageId) {
      await seed()
      const blob = get(project.id).blobs.get(imageId)
      if (!blob) throw new Error('Image bytes are not available in this browser.')
      return blob
    },

    async removeImage(project, imageId) {
      const s = get(project.id)
      s.blobs.delete(imageId)
      s.annotations.delete(imageId)
      s.project.images = s.project.images.filter((i) => i.id !== imageId)
    },

    async exportArchive(projectId) {
      const s = get(projectId)
      const files: Record<string, Uint8Array> = {
        'project.json': strToU8(JSON.stringify(s.project, null, 2)),
        'summary.csv': strToU8(await (await repo.exportSummaryCsv(projectId)).text()),
      }
      for (const [id, doc] of s.annotations) files[`annotations/${id}.json`] = strToU8(JSON.stringify(doc, null, 2))
      for (const img of s.project.images) {
        const blob = s.blobs.get(img.id)
        if (blob) files[`images/${img.id}.${img.mimeType.split('/')[1] ?? 'bin'}`] = new Uint8Array(await blob.arrayBuffer())
      }
      return new Blob([zipSync(files) as Uint8Array<ArrayBuffer>], { type: 'application/zip' })
    },

    async importArchive(file) {
      const entries = unzipSync(new Uint8Array(await file.arrayBuffer()))
      if (!entries['project.json']) throw new Error('This .zip has no project.json — is it a CFU Count project?')
      const project = JSON.parse(strFromU8(entries['project.json'])) as Project
      if (store.has(project.id)) project.id = newId()
      const s: Stored = { project, annotations: new Map(), blobs: new Map() }
      for (const [path, bytes] of Object.entries(entries)) {
        const ann = /^annotations\/(.+)\.json$/.exec(path)
        if (ann) s.annotations.set(ann[1], { ...JSON.parse(strFromU8(bytes)), projectId: project.id })
        const img = /^images\/([^.]+)\./.exec(path)
        if (img) {
          const rec = project.images.find((i) => i.id === img[1])
          s.blobs.set(img[1], new Blob([bytes as Uint8Array<ArrayBuffer>], { type: rec?.mimeType }))
        }
      }
      project.storage = { kind: 'local' }
      store.set(project.id, s)
      markOpen(s)
      return opened(s)
    },

    async exportSummaryCsv(projectId) {
      const { project, annotations } = get(projectId)
      const esc = (v: string | number) => {
        let t = String(v)
        if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`
        return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t
      }
      const rows = [['project', 'image_group', 'image', 'annotation_group', 'confirmed', 'manual', 'automated', 'hidden', 'locked']]
      for (const img of project.images) {
        const doc = annotations.get(img.id)
        const counts = confirmedCountsByGroup(doc?.annotations)
        for (const g of project.annotationGroups) {
          const list = (doc?.annotations ?? []).filter((a) => a.groupId === g.id && a.reviewStatus === 'accepted')
          rows.push([
            project.name,
            project.imageGroups.find((ig) => ig.id === img.imageGroupId)?.name ?? '',
            img.name,
            g.name,
            String(counts.get(g.id) ?? 0),
            String(list.filter((a) => a.origin === 'manual').length),
            String(list.filter((a) => a.origin === 'automated').length),
            String(g.hidden),
            String(g.locked),
          ])
        }
      }
      return new Blob(['﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' })
    },

    // ---- simulated Drive (only with ?fakeDrive) ----
    async connectDrive() {
      if (!driveMode) throw new Error('Google Drive is not configured in this build.')
      setDrive({ state: 'connecting' })
      await delay(700)
      setDrive({ state: 'connected', account: 'demo.user@example.com', expiresAt: Date.now() + 3600_000 })
    },
    async disconnectDrive() {
      setDrive(driveMode ? { state: 'disconnected' } : { state: 'unconfigured' })
    },
    async linkProjectToDrive(projectId, mode) {
      requireDrive()
      await delay(600)
      const s = get(projectId)
      s.project.storage = {
        kind: 'drive',
        folderId: newId(),
        folderName: mode === 'create-folder' ? s.project.name : 'Lab plates 2026',
        files: { annotations: {} },
        remoteVersions: {},
        account: 'demo.user@example.com',
      }
      setStatus({ state: 'saved-drive', at: now() })
      emitProject(s)
      return opened(s)
    },
    async openProjectFromDrive() {
      requireDrive()
      await delay(500)
      throw new Error('The demo storage cannot open real Drive folders.')
    },
    async importImagesFromDrive() {
      requireDrive()
      await delay(300)
      return { added: [], rejected: [{ name: 'Drive picker', reason: 'Not available in demo storage.' }] }
    },
    async saveToDrive(projectId, opts) {
      requireDrive()
      setStatus({ state: 'saving-drive' })
      await delay(900)
      if (driveMode === 'conflict' && !opts?.overwrite) {
        setStatus({ state: 'conflict', files: ['project.json', `annotations/${get(projectId).project.images[0]?.id ?? 'x'}.json`] })
        return
      }
      setStatus({ state: 'saved-drive', at: now() })
    },
    async takeRemote(projectId) {
      requireDrive()
      await delay(500)
      const s = get(projectId)
      setStatus({ state: 'saved-drive', at: now() })
      return opened(s)
    },
  }
  return repo
}
