import { describe, expect, it } from 'vitest'
import type { VersionReason } from '../api'
import { buildRestoredState, computeCounts, contentKey, decodePayload, DEFAULT_RETENTION, encodeJson, planQuotaRelief, planRetention, type RetentionItem } from '../versions'
import { annotation, doc, image, project } from './fakes'

const H = 3_600_000
const D = 24 * H
const NOW = Date.parse('2026-10-09T12:00:00Z')
const at = (ageMs: number) => new Date(NOW - ageMs).toISOString()
let seq = 0
const v = (ageMs: number, reason: VersionReason = 'periodic'): RetentionItem => ({ id: `v${seq++}-${ageMs}`, createdAt: at(ageMs), reason })
const kept = (items: RetentionItem[], policy = DEFAULT_RETENTION) => {
  const doomed = planRetention(items, NOW, policy)
  return items.filter((i) => !doomed.has(i.id))
}

describe('retention (pure, fixed clock)', () => {
  it('keeps everything from the last 24 hours', () => {
    const items = Array.from({ length: 30 }, (_, i) => v(i * 10 * 60_000)) // every 10 min for 5 h
    expect(kept(items)).toHaveLength(30)
  })

  it('keeps one per hour between 24 h and 7 days, preferring safety, then manual, then the newest', () => {
    const base = 2 * D + 30 * 60_000 // inside one clock hour (NOW is on the hour)
    const newest = v(base - 20 * 60_000)
    const older = v(base)
    const recent = () => [v(0), v(1), v(2)] // the newest three are always kept
    expect(kept([...recent(), newest, older]).map((i) => i.id)).toContain(newest.id)
    expect(kept([...recent(), newest, older]).map((i) => i.id)).not.toContain(older.id)
    const safety = v(base - 10 * 60_000, 'before-destructive')
    const manual = v(base - 5 * 60_000, 'manual')
    const out = kept([v(0), v(1), v(2), manual, safety, newest, older]).map((i) => i.id)
    expect(out).toContain(safety.id)
    expect(out).not.toContain(manual.id)
    expect(out).not.toContain(newest.id)
  })

  it('keeps one per day between 7 and 30 days and drops older ones', () => {
    const items = [v(0), v(1), v(2)]
    for (let d = 8; d < 40; d++) items.push(v(d * D + 2 * H), v(d * D + 5 * H))
    const out = kept(items)
    const old = out.filter((i) => NOW - Date.parse(i.createdAt) >= 7 * D)
    const days = new Set(old.map((i) => Math.floor(Date.parse(i.createdAt) / D)))
    expect(old.length).toBe(days.size) // at most one per day
    expect(old.every((i) => NOW - Date.parse(i.createdAt) < 30 * D + D)).toBe(true)
    expect(out.length).toBeLessThan(items.length)
  })

  it('always keeps the newest versions of an idle project, whatever their age', () => {
    const items = [v(90 * D), v(91 * D), v(92 * D), v(93 * D)]
    expect(kept(items).map((i) => i.id)).toEqual(items.slice(0, 3).map((i) => i.id))
  })

  it('never deletes the most recent pre-destructive version within 7 days, even above the cap', () => {
    const safety = v(6 * D, 'before-destructive')
    const items = [safety]
    for (let i = 0; i < 300; i++) items.push(v(i * 60_000)) // 300 in the last 5 hours
    const out = kept(items)
    expect(out).toHaveLength(DEFAULT_RETENTION.max)
    expect(out.map((i) => i.id)).toContain(safety.id)
    // Older than 7 days it gets bucketed like any other version.
    const expired = v(8 * D + H, 'before-destructive')
    const sameDay = v(8 * D + 30 * 60_000, 'before-destructive')
    expect(kept([v(0), v(1), v(2), sameDay, expired]).map((i) => i.id)).not.toContain(expired.id)
  })

  it('caps the number of versions by dropping the oldest', () => {
    const items = Array.from({ length: 250 }, (_, i) => v(i * 60_000))
    const out = kept(items)
    expect(out).toHaveLength(200)
    expect(out.at(-1)!.id).toBe(items[199].id)
  })

  it('quota relief removes the oldest automatic versions first and never the protected ones', () => {
    const safety = v(3 * H, 'before-destructive')
    const manual = v(10 * H, 'manual')
    const auto = Array.from({ length: 8 }, (_, i) => v((i + 1) * H, 'periodic'))
    const victims = planQuotaRelief([safety, manual, ...auto], NOW)
    expect(victims).toEqual([auto[7].id, auto[6].id])
    expect(planQuotaRelief([v(0, 'manual'), v(H, 'manual')], NOW)).toEqual([expect.stringContaining('v')])
    expect(planQuotaRelief([v(0, 'periodic')], NOW)).toEqual([])
  })
})

describe('version payloads', () => {
  it('content keys are stable and change with the content', () => {
    const a = JSON.stringify({ x: 1, y: [1, 2, 3] })
    expect(contentKey(a)).toBe(contentKey(String(a)))
    expect(contentKey(a)).not.toBe(contentKey(JSON.stringify({ x: 1, y: [1, 2, 4] })))
  })

  it('encodes and decodes JSON losslessly', () => {
    const value = { name: 'Plates “A” µ', n: [1.5, -2, 3e-7] }
    const { data, rawBytes } = encodeJson(JSON.stringify(value))
    expect(rawBytes).toBe(new TextEncoder().encode(JSON.stringify(value)).length)
    expect(decodePayload(data)).toEqual(value)
  })

  it('counts confirmed annotations per group on images that are part of the project', () => {
    const p = project({ images: [image('i1'), image('i2'), image('i3', { deletedAt: '2026-01-05T00:00:00.000Z' })] })
    const counts = computeCounts(p, [
      doc(p, 'i1', [annotation('a', 'g1'), annotation('b', 'g2'), annotation('c', 'g1', { origin: 'automated', reviewStatus: 'unreviewed' })]),
      doc(p, 'i2', [annotation('d', 'g1')]),
      doc(p, 'i3', [annotation('e', 'g1')]),
    ])
    expect(counts).toEqual({
      annotations: 3,
      images: 2,
      groups: [
        { id: 'g1', name: 'Main colonies', color: '#e5484d', count: 2 },
        { id: 'g2', name: 'Small', color: '#e5484d', count: 1 },
      ],
    })
  })
})

describe('buildRestoredState', () => {
  it('takes editor data from the version and storage-owned fields from the working copy', () => {
    const version = project({ name: 'Old name', images: [image('i1'), image('i2')] })
    const versionDocs = new Map([['i1', doc(version, 'i1', [annotation('a', 'g1')])]])
    const current = project({
      name: 'New name',
      revision: 9,
      storage: { kind: 'drive', folderId: 'f', folderName: 'Plates' },
      images: [image('i1', { source: { kind: 'drive', fileId: 'x' } as never }), image('i2'), image('i3')],
    })
    const currentDocs = [doc(current, 'i1', []), doc(current, 'i2', [annotation('b', 'g1')]), doc(current, 'i3', [annotation('c', 'g1')])]
    const r = buildRestoredState({ project: current, docs: currentDocs }, { project: version, docs: versionDocs }, '2026-10-09T12:00:00.000Z')
    expect(r.project.name).toBe('Old name')
    expect(r.project.storage).toEqual(current.storage)
    expect(r.project.revision).toBe(9)
    expect(r.project.images.find((i) => i.id === 'i1')!.source).toEqual({ kind: 'drive', fileId: 'x' })
    // i3 was added later: kept, soft-deleted, with its annotations.
    expect(r.removedLater).toEqual(['i3'])
    expect(r.project.images.find((i) => i.id === 'i3')!.deletedAt).toBe('2026-10-09T12:00:00.000Z')
    const byId = new Map(r.docs.map((d) => [d.imageId, d]))
    expect(byId.get('i1')!.annotations.map((a) => a.id)).toEqual(['a'])
    expect(byId.get('i2')!.annotations).toEqual([]) // no doc in the version: emptied, not left stale
    expect(byId.get('i3')!.annotations.map((a) => a.id)).toEqual(['c'])
  })
})
