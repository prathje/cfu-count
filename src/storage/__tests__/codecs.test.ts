import { describe, expect, it } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { buildSummaryCsv, CSV_COLUMNS, encodeCell, parseCsv } from '../csv'
import { decodeArchive, encodeArchive } from '../archive'
import { inspectImage, sha256Hex, sniffFormat, UnsupportedImageError } from '../images'
import { validateImageAnnotations, validateProject } from '../validate'
import { SchemaError } from '../errors'
import { annotation, doc, fakeDecoder, PNG_1x1, project } from './fakes'

describe('CSV encoding', () => {
  it('quotes per RFC 4180', () => {
    expect(encodeCell('plain')).toBe('plain')
    expect(encodeCell('a,b')).toBe('"a,b"')
    expect(encodeCell('say "hi"')).toBe('"say ""hi"""')
    expect(encodeCell('two\nlines')).toBe('"two\nlines"')
    expect(encodeCell(' padded ')).toBe('" padded "')
    expect(encodeCell(3)).toBe('3')
    expect(encodeCell(true)).toBe('true')
  })

  it('neutralises formula-like text', () => {
    for (const s of ['=SUM(A1)', '+1', '-2', '@cmd', '\tx', '\rx']) {
      expect(parseCsv(encodeCell(s))[0][0]).toBe(`'${s}`)
    }
    expect(encodeCell('a=b')).toBe('a=b')
  })
})

describe('summary CSV', () => {
  const p = project({ name: '=HYPERLINK("x")' })
  p.images[1].source = { kind: 'drive', fileId: 'drv1' }
  const docs = new Map([
    [
      'i1',
      doc(p, 'i1', [
        annotation('a1', 'g1'),
        annotation('a2', 'g1'),
        annotation('a3', 'g2'), // hidden + locked group still counts
        annotation('a4', 'g1', { origin: 'automated', reviewStatus: 'accepted', lastEditSource: 'automated' }),
        annotation('a5', 'g1', { origin: 'automated', reviewStatus: 'unreviewed', lastEditSource: 'automated' }),
        annotation('a6', 'g1', { origin: 'automated', reviewStatus: 'rejected', lastEditSource: 'automated' }),
        annotation('a7', 'gX'), // group missing from project
      ]),
    ],
  ])
  const csv = buildSummaryCsv(p, docs)
  const rows = parseCsv(csv)
  const header = rows[0]
  const col = (r: string[], name: (typeof CSV_COLUMNS)[number]) => r[header.indexOf(name)]

  it('starts with a UTF-8 BOM and uses CRLF', () => {
    expect(csv.startsWith('﻿project_id,')).toBe(true)
    expect(csv).toContain('\r\n')
  })

  it('has one row per image × group, including zero counts and orphan groups', () => {
    const body = rows.slice(1)
    // i1: g1, g2, gX ; i2: g1, g2
    expect(body).toHaveLength(5)
    const i2 = body.filter((r) => col(r, 'image_id') === 'i2')
    expect(i2.map((r) => col(r, 'confirmed_count'))).toEqual(['0', '0'])
    expect(col(i2[0], 'drive_file_id')).toBe('drv1')
  })

  it('counts manual + accepted automated as confirmed and keeps suggestions separate', () => {
    const g1 = rows.find((r) => col(r, 'image_id') === 'i1' && col(r, 'annotation_group_id') === 'g1')!
    expect(col(g1, 'manual_count')).toBe('2')
    expect(col(g1, 'automated_accepted_count')).toBe('1')
    expect(col(g1, 'automated_unreviewed_count')).toBe('1')
    expect(col(g1, 'confirmed_count')).toBe('3')
    expect(col(g1, 'image_group_name')).toBe('Treatment A')
    const g2 = rows.find((r) => col(r, 'image_id') === 'i1' && col(r, 'annotation_group_id') === 'g2')!
    expect(col(g2, 'confirmed_count')).toBe('1')
    expect(col(g2, 'group_hidden')).toBe('true')
    expect(col(g2, 'group_locked')).toBe('true')
    const gx = rows.find((r) => col(r, 'annotation_group_id') === 'gX')!
    expect(col(gx, 'confirmed_count')).toBe('1')
  })

  it('neutralises user text such as project names', () => {
    expect(col(rows[1], 'project_name')).toBe(`'=HYPERLINK("x")`)
  })
})

describe('archive round trip', () => {
  it('preserves project, annotations, origin and image bytes', async () => {
    const p = project()
    p.images[0].fingerprint = await sha256Hex(PNG_1x1)
    p.images[1].fingerprint = await sha256Hex(PNG_1x1)
    p.storage = { kind: 'drive', folderId: 'F', folderName: 'Folder', account: 'me@example.com' }
    const docs = new Map([['i1', doc(p, 'i1', [annotation('a1', 'g1'), annotation('a2', 'g1', { origin: 'automated', reviewStatus: 'accepted', manuallyAdjusted: true, detector: { name: 'd', version: '1', runId: 'r', confidence: null } })])]])
    const zip = await encodeArchive({ project: p, annotations: docs, images: new Map([['i1', new Blob([PNG_1x1], { type: 'image/png' })]]) })
    const out = await decodeArchive(zip)
    expect(out.project.images).toEqual(p.images)
    expect(out.project.annotationGroups).toEqual(p.annotationGroups)
    // browser-local data is not exported
    expect(out.project.storage.kind === 'drive' && out.project.storage.account).toBeFalsy()
    expect(out.annotations.get('i1')).toEqual(docs.get('i1'))
    expect(out.annotations.get('i1')!.annotations[1].origin).toBe('automated')
    expect(new Uint8Array(await out.images.get('i1')!.arrayBuffer())).toEqual(PNG_1x1)
    expect(out.warnings).toEqual(['The archive has no image file for "i2.png".'])
  })

  it('round-trips detection runs and fitted geometry', async () => {
    const p = project()
    const d = doc(p, 'i1', [
      annotation('a1', 'g1', { origin: 'automated', reviewStatus: 'accepted', lastEditSource: 'automated', detector: { name: 'seeded', version: '1', runId: 'run1', confidence: 0.8 }, geometry: { kind: 'circle', r: 4.5, quality: 0.9, source: 'fit' } }),
    ])
    d.detectionRuns = [
      {
        runId: 'run1',
        method: 'seeded-blob',
        version: '1',
        createdAt: '2026-01-03T00:00:00.000Z',
        imageFingerprint: p.images[0].fingerprint,
        seedImageFingerprints: { i2: p.images[1].fingerprint },
        analysisScale: 0.5,
        targetGroupId: 'g1',
        roi: { kind: 'circle', cx: 320, cy: 240, r: 200 },
        seeds: [{ annotationId: 'm1', imageId: 'i2', x: 5, y: 6, radiusPx: null, quality: 'touching' }],
        prior: { logRadiusMu: 1.2 },
        settings: { sensitivity: 0.5 },
        negatives: [{ x: 1, y: 2 }],
      },
    ]
    const zip = await encodeArchive({ project: p, annotations: new Map([['i1', d]]), images: new Map() })
    const out = await decodeArchive(zip)
    expect(out.annotations.get('i1')).toEqual(d)

    const bad = structuredClone(d)
    ;(bad.detectionRuns[0].seeds[0] as { quality: string }).quality = 'great'
    const badZip = await encodeArchive({ project: p, annotations: new Map([['i1', bad]]), images: new Map() })
    await expect(decodeArchive(badZip)).rejects.toThrow(/quality/)
  })

  it('rejects archives without project.json or with a newer schema', async () => {
    await expect(decodeArchive(zipSync({ 'readme.txt': strToU8('hi') }))).rejects.toThrow(/project.json/)
    const newer = { ...project(), schemaVersion: 2 }
    await expect(decodeArchive(zipSync({ 'project.json': strToU8(JSON.stringify(newer)) }))).rejects.toThrow(/newer version/)
    await expect(decodeArchive(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(SchemaError)
  })

  it('rejects invalid annotation documents', async () => {
    const p = project()
    const bad = { ...doc(p, 'i1', [annotation('a1', 'g1')]) } as Record<string, unknown>
    ;(bad.annotations as Record<string, unknown>[])[0].origin = 'magic'
    const zip = zipSync({ 'project.json': strToU8(JSON.stringify(p)), 'annotations/i1.json': strToU8(JSON.stringify(bad)) })
    await expect(decodeArchive(zip)).rejects.toThrow(/origin/)
  })
})

describe('validateProject', () => {
  it('defaults a missing labelSize to 12', () => {
    const p = JSON.parse(JSON.stringify(project()))
    delete p.annotationGroups[0].labelSize
    expect(validateProject(p).annotationGroups[0].labelSize).toBe(12)
  })

  it('ungroups images with an unknown image group (warning) and rejects duplicate IDs', () => {
    const p = project()
    p.images[0].imageGroupId = 'nope'
    const warnings: string[] = []
    const v = validateProject(JSON.parse(JSON.stringify(p)), 'project.json', warnings)
    expect(v.images[0].imageGroupId).toBeNull()
    expect(warnings.join(' ')).toMatch(/Ungrouped/)
    const q = project()
    q.images[1].id = 'i1'
    expect(() => validateProject(JSON.parse(JSON.stringify(q)))).toThrow(/duplicate/)
  })
})

describe('validateImageAnnotations', () => {
  it('normalises manual marks to accepted so CSV and UI agree', () => {
    const p = project()
    const d = doc(p, 'i1', [annotation('a1', 'g1', { reviewStatus: 'unreviewed' })])
    const v = validateImageAnnotations(JSON.parse(JSON.stringify(d)))
    expect(v.annotations[0].reviewStatus).toBe('accepted')
  })
})

describe('image intake', () => {
  const head = (bytes: number[], ascii = '') => new Uint8Array([...bytes, ...[...ascii].map((c) => c.charCodeAt(0))])

  it('sniffs formats from magic bytes', () => {
    expect(sniffFormat(PNG_1x1)?.mimeType).toBe('image/png')
    expect(sniffFormat(head([0xff, 0xd8, 0xff, 0xe0]))?.mimeType).toBe('image/jpeg')
    expect(sniffFormat(head([], 'RIFF\0\0\0\0WEBP'))?.mimeType).toBe('image/webp')
    expect(sniffFormat(head([0, 0, 0, 0x18], 'ftypheic'))?.mimeType).toBe('image/heic')
    expect(sniffFormat(head([0, 0, 0, 0x18], 'ftypavif'))?.mimeType).toBe('image/avif')
    expect(sniffFormat(head([0x49, 0x49, 0x2a, 0]))?.mimeType).toBe('image/tiff')
    expect(sniffFormat(head([], 'hello world'))).toBeNull()
  })

  it('measures, fingerprints and rejects clearly', async () => {
    const info = await inspectImage(new Blob([PNG_1x1]), fakeDecoder)
    expect(info).toMatchObject({ mimeType: 'image/png', width: 640, height: 480, byteSize: PNG_1x1.length })
    expect(info.fingerprint).toMatch(/^[0-9a-f]{64}$/)

    await expect(inspectImage(new Blob([head([0x49, 0x49, 0x2a, 0, 1, 2])]), fakeDecoder)).rejects.toThrow(/TIFF/)
    await expect(inspectImage(new Blob(['not an image']), fakeDecoder)).rejects.toBeInstanceOf(UnsupportedImageError)
    await expect(inspectImage(new Blob([]), fakeDecoder)).rejects.toThrow(/empty/)
    const failing = async () => {
      throw new Error('cannot decode')
    }
    await expect(inspectImage(new Blob([head([0, 0, 0, 0x18], 'ftypheic\0\0\0\0')]), failing)).rejects.toThrow(/Safari/)
    await expect(inspectImage(new Blob([PNG_1x1]), async () => ({ width: 30000, height: 30000 }))).rejects.toThrow(/too large/)
  })
})
