import { describe, expect, it, vi } from 'vitest'
import { createSignal } from 'solid-js'
import type { Project } from '../model/types'
import { SCHEMA_VERSION } from '../model/types'
import type { OpenedProject, ProjectRepository, SaveStatus, DriveState } from '../storage/api'
import { createEditor } from './editor'
import type { Notice } from './messages'

function project(): Project {
  const img = (id: string, imageGroupId: string | null) => ({
    id,
    name: `${id}.jpg`,
    imageGroupId,
    width: 100,
    height: 80,
    mimeType: 'image/jpeg',
    byteSize: 1,
    fingerprint: `fp-${id}`,
    source: { kind: 'local' as const },
    addedAt: '2026-01-01T00:00:00.000Z',
  })
  return {
    schemaVersion: SCHEMA_VERSION,
    id: 'p1',
    name: 'Test',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    imageGroups: [{ id: 'ig1', name: 'Batch 1' }],
    images: [img('i1', 'ig1'), img('i2', null)],
    annotationGroups: [],
    storage: { kind: 'local' },
    excludedDriveFileIds: [],
    revision: 0,
  }
}

function mockRepo(opened: OpenedProject) {
  const [status] = createSignal<SaveStatus>({ state: 'idle' })
  const [drive] = createSignal<DriveState>({ state: 'unconfigured' })
  const listeners: ((p: Project) => void)[] = []
  const saveLocal = vi.fn(async () => {})
  const repo = {
    status,
    drive,
    listProjects: async () => [{ id: 'p1', name: 'Test', updatedAt: '', imageCount: 2, storage: 'local' as const }],
    openProject: async () => opened,
    saveLocal,
    onProjectUpdated: (l: (p: Project) => void) => {
      listeners.push(l)
      return () => {}
    },
    removeImage: async () => {},
  } as unknown as ProjectRepository
  return { repo, saveLocal, listeners }
}

async function setup() {
  const notices: Notice[] = []
  const { repo, saveLocal, listeners } = mockRepo({ project: project(), annotations: new Map() })
  const editor = createEditor(repo, (n) => notices.push(n))
  await editor.init()
  return { editor, notices, saveLocal, listeners }
}

describe('editor', () => {
  it('opens the project with a default "Colonies" group and selects the first image', async () => {
    const { editor } = await setup()
    expect(editor.state.phase).toBe('ready')
    expect(editor.groups().map((g) => g.name)).toEqual(['Colonies'])
    expect(editor.state.currentImageId).toBe('i1')
    expect(editor.activeGroup()?.name).toBe('Colonies')
  })

  it('adds manual annotations and derives counts', async () => {
    const { editor } = await setup()
    editor.addAnnotation(10, 20)
    editor.addAnnotation(30, 40)
    expect(editor.total()).toBe(2)
    expect(editor.currentAnnotations()[0]).toMatchObject({ origin: 'manual', reviewStatus: 'accepted', x: 10, y: 20 })
    expect(editor.imageCount('i1')).toBe(2)
    expect(editor.imageCount('i2')).toBe(0)
  })

  it('scopes undo/redo to the current image', async () => {
    const { editor } = await setup()
    editor.addAnnotation(1, 1)
    editor.selectImage('i2')
    expect(editor.canUndo()).toBe(false)
    expect(editor.undo()).toBe(false)
    expect(editor.imageCount('i1')).toBe(1)
    editor.selectImage('i1')
    expect(editor.undo()).toBe(true)
    expect(editor.imageCount('i1')).toBe(0)
    expect(editor.redo()).toBe(true)
    expect(editor.imageCount('i1')).toBe(1)
  })

  it('refuses edits and undo on locked/hidden groups with an explanation', async () => {
    const { editor, notices } = await setup()
    const id = editor.activeGroup()!.id
    editor.addAnnotation(1, 1)
    editor.toggleLocked(id)
    expect(editor.addAnnotation(2, 2)).toBe(false)
    expect(notices.at(-1)?.message).toMatch(/locked/)
    expect(editor.undo()).toBe(false)
    expect(notices.at(-1)?.detail).toMatch(/Unlock/)
    expect(editor.total()).toBe(1)
    expect(editor.setGroupStyle(id, { opacity: 0.5 })).toBe(false)
    editor.toggleLocked(id)
    editor.toggleHidden(id)
    expect(editor.undo()).toBe(false)
    expect(notices.at(-1)?.detail).toMatch(/hidden/)
    expect(editor.total()).toBe(1) // hidden still counted
    notices.at(-1)?.action?.run() // "Show group"
    expect(editor.activeGroup()?.hidden).toBe(false)
    expect(editor.undo()).toBe(true)
    expect(editor.total()).toBe(0)
  })

  it('applyBatch is a single undo step', async () => {
    const { editor } = await setup()
    const groupId = editor.activeGroup()!.id
    const mk = (id: string) => ({
      kind: 'add' as const,
      annotation: {
        id,
        x: 1,
        y: 1,
        groupId,
        origin: 'automated' as const,
        createdAt: '',
        updatedAt: '',
        reviewStatus: 'accepted' as const,
        lastEditSource: 'automated' as const,
        manuallyAdjusted: false,
      },
    })
    expect(editor.applyBatch('i1', [mk('a'), mk('b'), mk('c')], { label: 'Accept 3 suggestions' })).toBeNull()
    expect(editor.total()).toBe(3)
    editor.undo()
    expect(editor.total()).toBe(0)
  })

  it('applyBatch records a detection run in the same undo step and keeps geometry', async () => {
    const { editor } = await setup()
    const groupId = editor.activeGroup()!.id
    const run = { runId: 'run1', method: 'test', version: '0', createdAt: '', imageFingerprint: 'fp-i1', analysisScale: 1, targetGroupId: groupId } as never
    const annotation = {
      id: 'auto1', x: 1, y: 1, groupId, origin: 'automated' as const, createdAt: '', updatedAt: '',
      reviewStatus: 'accepted' as const, lastEditSource: 'automated' as const, manuallyAdjusted: false,
      geometry: { kind: 'circle' as const, r: 4, source: 'fit' as const },
    }
    editor.applyBatch('i1', [{ kind: 'add', annotation }], { label: 'Accept 1 suggestion', detectionRun: run })
    expect(editor.state.docs['i1'].detectionRuns.map((r) => r.runId)).toEqual(['run1'])
    editor.undo()
    expect(editor.state.docs['i1'].detectionRuns).toEqual([])
    editor.redo()
    expect(editor.state.docs['i1'].detectionRuns).toHaveLength(1)
    expect(editor.currentAnnotations()[0]).toMatchObject({ origin: 'automated', geometry: { r: 4 } })
  })

  it('reassigning images keeps annotations; deleting an image group ungroups images', async () => {
    const { editor } = await setup()
    editor.addAnnotation(5, 5)
    const ig = editor.createImageGroup('Treatment B')!
    editor.assignImage('i1', ig)
    expect(editor.state.project!.images.find((i) => i.id === 'i1')!.imageGroupId).toBe(ig)
    expect(editor.imageCount('i1')).toBe(1)
    editor.deleteImageGroup(ig)
    expect(editor.state.project!.images.find((i) => i.id === 'i1')!.imageGroupId).toBeNull()
    expect(editor.imageCount('i1')).toBe(1)
  })

  it('deleting a group removes its annotations and history; last group cannot be deleted', async () => {
    const { editor } = await setup()
    const first = editor.activeGroup()!.id
    expect(editor.deleteGroup(first)).toBe(false)
    const second = editor.createGroup('Small')!
    expect(editor.state.activeGroupId).toBe(second)
    editor.addAnnotation(1, 1)
    editor.setActiveGroup(first)
    editor.addAnnotation(2, 2)
    expect(editor.groupUsage(second)).toEqual({ annotations: 1, images: 1 })
    expect(editor.deleteGroup(second)).toBe(true)
    expect(editor.total()).toBe(1)
    editor.undo() // undoes the "first" add
    expect(editor.total()).toBe(0)
    expect(editor.canUndo()).toBe(false)
  })

  it('autosaves changed docs with refreshed group snapshots', async () => {
    const { editor, saveLocal } = await setup()
    editor.addAnnotation(1, 1)
    await editor.flush()
    const calls = saveLocal.mock.calls as unknown as [Project, { imageId: string; groups: unknown[] }[]][]
    const last = calls.at(-1)!
    expect(last[1].map((d) => d.imageId)).toEqual(['i1'])
    expect(last[1][0].groups).toHaveLength(1)
  })

  it('merges storage-owned fields from onProjectUpdated', async () => {
    const { editor, listeners } = await setup()
    editor.renameProject('Renamed')
    const updated = project()
    updated.storage = {
      kind: 'drive',
      folderId: 'f',
      folderName: 'Folder',
      files: { annotations: {} },
      remoteVersions: {},
    }
    updated.images[0].sourceMismatch = { detectedAt: '', message: 'Replaced' }
    listeners.forEach((l) => l(updated))
    expect(editor.state.project!.storage.kind).toBe('drive')
    expect(editor.state.project!.name).toBe('Renamed')
    expect(editor.state.project!.images[0].sourceMismatch?.message).toBe('Replaced')
  })
})
