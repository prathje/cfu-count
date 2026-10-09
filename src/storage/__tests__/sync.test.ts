import { beforeEach, describe, expect, it } from 'vitest'
import type { ID, ImageAnnotations, Project } from '../../model/types'
import { DriveError } from '../errors'
import { newDriveLink, pullFolder, pushProject, type DriveFiles, type PushInput } from '../drive/sync'
import { emptyDriveFiles } from '../localStore'
import { annotation, doc, FakeDrive, PNG_1x1, project } from './fakes'

const now = () => '2026-03-01T00:00:00.000Z'

describe('Drive sync engine', () => {
  let drive: FakeDrive
  let folder: string
  let p: Project
  let docs: Map<ID, ImageAnnotations>
  let saved: Project | null
  let savedFiles: DriveFiles | null

  function input(over: Partial<PushInput> = {}): PushInput {
    return {
      project: saved ?? p,
      files: savedFiles ?? emptyDriveFiles(),
      annotations: docs,
      dirtyImages: new Set(docs.keys()),
      overwrite: false,
      loadImage: async () => new Blob([PNG_1x1], { type: 'image/png' }),
      checkpoint: async (cp, files) => {
        saved = cp
        savedFiles = files
      },
      ...over,
    }
  }

  async function push(over: Partial<PushInput> = {}) {
    const r = await pushProject(drive, input(over))
    if (r.kind === 'saved') {
      saved = r.project
      savedFiles = r.files
    }
    return r
  }

  beforeEach(() => {
    drive = new FakeDrive()
    folder = drive.addFolder('Plate counts')
    p = project({ storage: newDriveLink(folder, 'Plate counts') })
    docs = new Map([['i1', doc(p, 'i1', [annotation('a1', 'g1')])]])
    saved = null
    savedFiles = null
  })

  it('writes the folder layout and uploads local images to images/', async () => {
    const r = await push()
    expect(r.kind).toBe('saved')
    const names = drive.childrenOf(folder).map((f) => f.name).sort()
    expect(names).toEqual(['annotations', 'images', 'project.json', 'summary.csv'])
    const annDir = drive.findByName(folder, 'annotations')!.id
    expect(drive.childrenOf(annDir).map((f) => f.name)).toEqual(['i1.json'])
    const imgDir = drive.findByName(folder, 'images')!.id
    expect(drive.childrenOf(imgDir).map((f) => f.name).sort()).toEqual(['i1.png', 'i2.png'])
    expect(saved!.images.every((i) => i.source.kind === 'drive')).toBe(true)
    // project.json written last and references outputs by ID, without browser-local data
    expect(drive.calls.filter((c) => c.startsWith('create')).at(-1)).toBe('create project.json')
    const remote = JSON.parse(drive.text(drive.findByName(folder, 'project.json')!.id))
    expect(remote.storage.files.annotations.i1).toBeTruthy()
    expect(remote.storage.files.remoteVersions).toBeUndefined()
    expect(remote.storage.remoteVersions).toBeUndefined()
    // the model link stays clean: bookkeeping lives in DriveFiles
    expect(Object.keys(saved!.storage).sort()).toEqual(['folderId', 'folderName', 'kind'])
  })

  it('updates the same file IDs on later saves (no duplicates)', async () => {
    await push()
    const fileCount = drive.files.size
    docs.set('i1', doc(p, 'i1', [annotation('a1', 'g1'), annotation('a2', 'g1')]))
    const r = await push({ dirtyImages: new Set(['i1']) })
    expect(r.kind).toBe('saved')
    expect(drive.files.size).toBe(fileCount)
    expect(drive.count('update')).toBe(3) // annotation doc, summary.csv, project.json
  })

  it('skips annotation docs that are not dirty', async () => {
    await push()
    drive.calls.length = 0
    await push({ dirtyImages: new Set() })
    expect(drive.calls.filter((c) => c.startsWith('update') || c.startsWith('create'))).toHaveLength(2) // csv + project.json
  })

  it('detects a remote change and does not overwrite without consent', async () => {
    await push()
    const pj = drive.findByName(folder, 'project.json')!.id
    drive.externalEdit(pj, '{"edited":"elsewhere"}')
    drive.calls.length = 0
    const r = await push()
    expect(r).toEqual({ kind: 'conflict', files: ['project.json'] })
    expect(drive.calls.some((c) => c.startsWith('update') || c.startsWith('create'))).toBe(false)
    expect(drive.text(pj)).toBe('{"edited":"elsewhere"}')

    const forced = await push({ overwrite: true })
    expect(forced.kind).toBe('saved')
    expect(JSON.parse(drive.text(pj)).id).toBe(p.id)
  })

  it('detects remote edits to an annotation document', async () => {
    await push()
    const annId = savedFiles!.annotations.i1
    drive.externalEdit(annId, '{}')
    const r = await push({ dirtyImages: new Set(['i1']) })
    expect(r).toEqual({ kind: 'conflict', files: ['annotations/i1.json'] })
  })

  it('treats an unknown project.json from another device as a conflict', async () => {
    drive.addFile('project.json', folder, '{"other":true}', 'application/json')
    const r = await push()
    expect(r.kind).toBe('conflict')
  })

  it('recreates outputs that were deleted remotely', async () => {
    await push()
    const pj = drive.findByName(folder, 'project.json')!
    drive.files.delete(pj.id)
    const r = await push()
    expect(r.kind).toBe('saved')
    expect(drive.findByName(folder, 'project.json')).toBeTruthy()
  })

  it('resumes an interrupted push without duplicating files', async () => {
    // Fail while writing summary.csv (after images + annotation docs were created).
    const realCreate = drive.create.bind(drive)
    let failed = false
    drive.create = async (meta, body) => {
      if (meta.name === 'summary.csv' && !failed) {
        failed = true
        throw new DriveError('network', 'offline')
      }
      return realCreate(meta, body)
    }
    await expect(push()).rejects.toThrow('offline')
    expect(saved).not.toBeNull() // checkpoints recorded the created IDs
    const before = drive.files.size
    const r = await push({ project: saved! })
    expect(r.kind).toBe('saved')
    expect(drive.files.size).toBe(before + 2) // only summary.csv + project.json
  })

  it('refuses read-only folders and deleted folders with clear errors', async () => {
    const ro = drive.addFolder('Shared', 'root', { canAddChildren: false })
    await expect(pushProject(drive, input({ project: { ...p, storage: newDriveLink(ro, 'Shared') } }))).rejects.toThrow(/view access/)
    drive.files.delete(folder)
    await expect(push()).rejects.toThrow(/deleted/)
  })

  it('round-trips through pull', async () => {
    await push()
    const r = await pullFolder(drive, folder, now)
    expect(r.project!.id).toBe(p.id)
    expect(r.project!.images.map((i) => i.id)).toEqual(['i1', 'i2'])
    expect(r.annotations.get('i1')).toEqual(docs.get('i1'))
    expect(r.inaccessible).toEqual([])
    expect(r.unreferencedImages).toEqual([])
    // the pulled link knows current content tokens, so an immediate push is conflict-free
    saved = r.project
    savedFiles = r.files
    expect((await push({ dirtyImages: new Set(['i1']) })).kind).toBe('saved')
  })

  it('reports files the app cannot read (drive.file not granted) and refuses to clobber them', async () => {
    await push()
    const annId = savedFiles!.annotations.i1
    drive.hidden.add(annId)
    const r = await pullFolder(drive, folder, now)
    expect(r.inaccessible).toContain(annId)
    expect(r.annotations.has('i1')).toBe(false)
    // editing that image locally must not silently overwrite the unseen remote doc
    saved = r.project
    savedFiles = r.files
    const res = await push({ dirtyImages: new Set(['i1']) })
    expect(res).toEqual({ kind: 'conflict', files: ['annotations/i1.json'] })
  })

  it('lists unreferenced images and flags replaced Drive images', async () => {
    await push()
    const imgDir = drive.findByName(folder, 'images')!.id
    const extra = drive.addFile('new-plate.jpg', imgDir, new Uint8Array([0xff, 0xd8, 0xff, 1]), 'image/jpeg')
    const i1File = saved!.images[0].source.kind === 'drive' ? saved!.images[0].source.fileId : ''
    drive.externalEdit(i1File, new Uint8Array([9, 9, 9]))
    const r = await pullFolder(drive, folder, now)
    expect(r.unreferencedImages.map((f) => f.id)).toEqual([extra])
    const i1 = r.project!.images.find((i) => i.id === 'i1')!
    expect(i1.sourceMismatch?.message).toMatch(/replaced/)
    expect(r.project!.images.find((i) => i.id === 'i2')!.sourceMismatch).toBeUndefined()
  })

  it('does not offer images the user removed (deletedAt) for re-import and keeps the flag', async () => {
    await push()
    saved = { ...saved!, images: saved!.images.map((i, n) => (n === 0 ? { ...i, deletedAt: '2026-02-01T00:00:00.000Z' } : i)) }
    await push()
    const r = await pullFolder(drive, folder, now)
    expect(r.unreferencedImages).toEqual([])
    expect(r.project!.images[0].deletedAt).toBe('2026-02-01T00:00:00.000Z')
  })

  it('returns project null for a folder without project.json', async () => {
    drive.addFile('plate.png', folder, PNG_1x1, 'image/png')
    const r = await pullFolder(drive, folder, now)
    expect(r.project).toBeNull()
    expect(r.unreferencedImages.map((f) => f.name)).toEqual(['plate.png'])
  })
})
