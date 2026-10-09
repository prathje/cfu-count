/** Test doubles and fixtures for storage tests. */
import { SCHEMA_VERSION } from '../../model/types'
import type { Annotation, AnnotationGroup, ImageAnnotations, ImageRecord, Project } from '../../model/types'
import { DriveError } from '../errors'
import { FOLDER_MIME, type DriveClient, type DriveFile, type NewFileMetadata } from '../drive/client'
import type { DrivePicker, PickFilesOptions, PickedItem } from '../drive/picker'
import type { AccessToken, TokenProvider } from '../drive/auth'

/** Cheap deterministic content hash standing in for Drive's md5Checksum. */
function fakeMd5(bytes: Uint8Array): string {
  let h = 0x811c9dc5
  for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0
  return `${h.toString(16)}-${bytes.length}`
}

interface Entry {
  meta: DriveFile
  content?: Uint8Array
}

/** In-memory Drive with drive.file-style visibility (`hidden` = not granted to the app). */
export class FakeDrive implements DriveClient {
  readonly files = new Map<string, Entry>()
  readonly hidden = new Set<string>()
  readonly calls: string[] = []
  private seq = 0
  /** Errors thrown by the next N calls (FIFO). */
  readonly failures: DriveError[] = []

  constructor() {
    this.files.set('root', { meta: { id: 'root', name: 'My Drive', mimeType: FOLDER_MIME, capabilities: { canAddChildren: true } } })
  }

  private check(): void {
    const f = this.failures.shift()
    if (f) throw f
  }

  private visible(id: string): Entry {
    const e = this.files.get(id)
    if (!e || this.hidden.has(id)) throw new DriveError('not-found', 'not found', { status: 404 })
    return e
  }

  addFolder(name: string, parent = 'root', opts: { canAddChildren?: boolean } = {}): string {
    const id = `f${++this.seq}`
    this.files.set(id, { meta: { id, name, mimeType: FOLDER_MIME, parents: [parent], version: '1', capabilities: { canAddChildren: opts.canAddChildren ?? true } } })
    return id
  }

  addFile(name: string, parent: string, content: Uint8Array | string, mimeType: string, appProperties?: Record<string, string>): string {
    const id = `x${++this.seq}`
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
    this.files.set(id, { meta: { id, name, mimeType, parents: [parent], version: '1', md5Checksum: fakeMd5(bytes), size: String(bytes.length), modifiedTime: new Date(1700000000000 + this.seq).toISOString(), appProperties }, content: bytes })
    return id
  }

  /** Simulate another device/user editing a file. */
  externalEdit(id: string, content: string | Uint8Array): void {
    const e = this.files.get(id)!
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
    e.content = bytes
    e.meta = { ...e.meta, md5Checksum: fakeMd5(bytes), version: String(Number(e.meta.version ?? 0) + 1), modifiedTime: new Date().toISOString() }
  }

  text(id: string): string {
    return new TextDecoder().decode(this.files.get(id)!.content)
  }

  childrenOf(parent: string): DriveFile[] {
    return [...this.files.values()].filter((e) => e.meta.parents?.includes(parent) && !e.meta.trashed).map((e) => e.meta)
  }

  findByName(parent: string, name: string): DriveFile | undefined {
    return this.childrenOf(parent).find((f) => f.name === name)
  }

  async about() {
    this.calls.push('about')
    return { email: 'tester@example.com', name: 'Tester' }
  }

  async getFile(fileId: string) {
    this.calls.push(`get ${fileId}`)
    this.check()
    return { ...this.visible(fileId).meta }
  }

  async listChildren(folderId: string) {
    this.calls.push(`list ${folderId}`)
    this.check()
    this.visible(folderId)
    return this.childrenOf(folderId).filter((f) => !this.hidden.has(f.id)).map((f) => ({ ...f }))
  }

  async download(fileId: string) {
    this.calls.push(`download ${fileId}`)
    this.check()
    const e = this.visible(fileId)
    return new Blob([(e.content ?? new Uint8Array()) as BlobPart], { type: e.meta.mimeType })
  }

  async create(meta: NewFileMetadata, body?: Blob) {
    this.calls.push(`create ${meta.name}`)
    this.check()
    for (const p of meta.parents) {
      const parent = this.visible(p)
      if (parent.meta.capabilities?.canAddChildren === false) throw new DriveError('forbidden', 'read-only', { status: 403 })
    }
    if (!body) {
      const id = this.addFolder(meta.name, meta.parents[0])
      this.files.get(id)!.meta.appProperties = meta.appProperties
      return { ...this.files.get(id)!.meta }
    }
    const id = this.addFile(meta.name, meta.parents[0], new Uint8Array(await body.arrayBuffer()), meta.mimeType, meta.appProperties)
    return { ...this.files.get(id)!.meta }
  }

  async updateContent(fileId: string, body: Blob, appProperties?: Record<string, string>) {
    this.calls.push(`update ${fileId}`)
    this.check()
    const e = this.visible(fileId)
    this.externalEdit(fileId, new Uint8Array(await body.arrayBuffer()))
    if (appProperties) e.meta.appProperties = { ...e.meta.appProperties, ...appProperties }
    return { ...e.meta }
  }

  count(prefix: string): number {
    return this.calls.filter((c) => c.startsWith(prefix)).length
  }
}

/** Scripted picker: each call shifts the next prepared answer. Picking un-hides files (drive.file grant). */
export class FakePicker implements DrivePicker {
  folders: (PickedItem | null)[] = []
  fileAnswers: ((opts: PickFilesOptions) => PickedItem[])[] = []
  readonly requests: PickFilesOptions[] = []
  private readonly drive: FakeDrive
  constructor(drive: FakeDrive) {
    this.drive = drive
  }
  async pickFolder(): Promise<PickedItem | null> {
    const f = this.folders.shift() ?? null
    if (f) this.drive.hidden.delete(f.id)
    return f
  }
  async pickFiles(_token: string, opts: PickFilesOptions): Promise<PickedItem[]> {
    this.requests.push(opts)
    const answer = this.fileAnswers.shift()
    const picked = answer ? answer(opts) : []
    for (const p of picked) this.drive.hidden.delete(p.id)
    return picked
  }
}

export class FakeTokenProvider implements TokenProvider {
  requests = 0
  expiresInMs = 3_600_000
  async preload() {}
  async requestToken(): Promise<AccessToken> {
    this.requests++
    return { accessToken: `token-${this.requests}`, expiresAt: Date.now() + this.expiresInMs, scopes: [] }
  }
  async revoke() {}
}

// ------------------------------------------------------------- fixtures

/** 1×1 PNG. */
export const PNG_1x1 = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
)

export const fakeDecoder = async () => ({ width: 640, height: 480 })

export function group(id: string, name: string, extra: Partial<AnnotationGroup> = {}): AnnotationGroup {
  return { id, name, color: '#e5484d', render: 'dot', opacity: 0.9, size: 6, labels: false, labelSize: 12, hidden: false, locked: false, ...extra }
}

export function image(id: string, extra: Partial<ImageRecord> = {}): ImageRecord {
  return {
    id,
    name: `${id}.png`,
    imageGroupId: null,
    width: 640,
    height: 480,
    mimeType: 'image/png',
    byteSize: PNG_1x1.length,
    fingerprint: 'fp-' + id,
    source: { kind: 'local' },
    addedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  }
}

export function annotation(id: string, groupId: string, extra: Partial<Annotation> = {}): Annotation {
  return {
    id,
    x: 10.5,
    y: 20.5,
    groupId,
    origin: 'manual',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    reviewStatus: 'accepted',
    lastEditSource: 'manual',
    manuallyAdjusted: false,
    ...extra,
  }
}

export function project(extra: Partial<Project> = {}): Project {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: 'p1',
    name: 'Plates',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    imageGroups: [{ id: 'ig1', name: 'Treatment A' }],
    images: [image('i1', { imageGroupId: 'ig1' }), image('i2')],
    annotationGroups: [group('g1', 'Main colonies'), group('g2', 'Small', { hidden: true, locked: true })],
    storage: { kind: 'local' },
    excludedDriveFileIds: [],
    revision: 1,
    ...extra,
  }
}

export function doc(p: Project, imageId: string, annotations: Annotation[]): ImageAnnotations {
  const img = p.images.find((i) => i.id === imageId)!
  return {
    schemaVersion: SCHEMA_VERSION,
    projectId: p.id,
    imageId,
    imageFingerprint: img.fingerprint,
    width: img.width,
    height: img.height,
    groups: p.annotationGroups,
    annotations,
    detectionRuns: [],
    updatedAt: '2026-01-02T00:00:00.000Z',
  }
}
