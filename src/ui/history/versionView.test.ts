import { describe, expect, it } from 'vitest'
import type { VersionInfo } from '../../storage/api'
import { annotation, doc, image, project } from '../../storage/__tests__/fakes'
import { currentCounts, deltaText, groupByDay, groupRows, imageRows, restoreSummary } from './versionView'

const version = (createdAt: string, extra: Partial<VersionInfo> = {}): VersionInfo => ({
  id: createdAt,
  projectId: 'p1',
  createdAt,
  reason: 'periodic',
  label: 'Automatic version',
  counts: { annotations: 0, images: 0, groups: [] },
  storedBytes: 0,
  ...extra,
})

describe('version history view', () => {
  it('groups versions by local day with Today / Yesterday titles', () => {
    const now = new Date(2026, 9, 9, 15, 0)
    const groups = groupByDay(
      [version(new Date(2026, 9, 9, 14).toISOString()), version(new Date(2026, 9, 9, 9).toISOString()), version(new Date(2026, 9, 8, 18).toISOString()), version(new Date(2026, 9, 1, 8).toISOString())],
      now,
    )
    expect(groups.map((g) => [g.title, g.versions.length])).toEqual([
      ['Today', 2],
      ['Yesterday', 1],
      [expect.stringMatching(/1/), 1],
    ])
  })

  it('describes counts relative to now', () => {
    expect(deltaText(312, 0)).toBe('312 more than now')
    expect(deltaText(3, 15)).toBe('12 fewer than now')
    expect(deltaText(7, 7)).toBe('same as now')
  })

  it('compares groups and images of a version with the project now', () => {
    const now = project({ images: [image('i1'), image('i2'), image('i3')] })
    const docsNow = { i1: doc(now, 'i1', []), i2: doc(now, 'i2', [annotation('b', 'g1')]), i3: doc(now, 'i3', [annotation('c', 'g1')]) }
    const old = project({ images: [image('i1'), image('i2')] })
    const snap = { project: old, annotations: new Map([['i1', doc(old, 'i1', [annotation('a', 'g1'), annotation('a2', 'g1')])], ['i2', doc(old, 'i2', [annotation('b', 'g1')])]]) }
    const rows = imageRows(snap, now, docsNow)
    expect(rows.map((r) => [r.id, r.version, r.now, r.changed, r.addedLater])).toEqual([
      ['i1', 2, 0, true, false],
      ['i2', 1, 1, false, false],
      ['i3', 0, 1, true, true],
    ])
    expect(restoreSummary(rows)).toBe('Annotations change on 1 image; 1 image added later moves to Recently removed (nothing is erased).')
    const cur = currentCounts(now, docsNow)
    expect(cur).toMatchObject({ annotations: 2, images: 3 })
    const v = version('2026-10-09T10:00:00.000Z', { counts: { annotations: 3, images: 2, groups: [{ id: 'g1', name: 'Main colonies', color: '#f00', count: 3 }, { id: 'gx', name: 'Gone', color: '#0f0', count: 0 }] } })
    expect(groupRows(v, now, cur).map((r) => [r.name, r.version, r.now, r.status])).toEqual([
      ['Main colonies', 3, 2, 'both'],
      ['Gone', 0, 0, 'version-only'],
      ['Small', 0, 0, 'now-only'],
    ])
  })
})
