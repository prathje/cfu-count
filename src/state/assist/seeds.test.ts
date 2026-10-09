import { describe, expect, it } from 'vitest'
import type { Annotation, AnnotationGroup, ImageRecord } from '../../model/types'
import { makeManualAnnotation } from '../../model/annotations'
import { makeGroup } from '../../model/groups'
import { buildRequest, defaultSeedSource, findBlock, MAX_SEEDS, referenceCandidates, seedAnnotations } from './seeds'
import { DEFAULT_REVIEW_SETTINGS } from './review'

const at = '2026-01-01T00:00:00.000Z'
const img = (id: string, over: Partial<ImageRecord> = {}): ImageRecord => ({
  id,
  name: `${id}.jpg`,
  imageGroupId: null,
  width: 6000,
  height: 4000,
  mimeType: 'image/jpeg',
  byteSize: 1,
  fingerprint: `fp-${id}`,
  source: { kind: 'local' },
  addedAt: at,
  ...over,
})
const manual = (n: number, groupId = 'g1', prefix = 'm'): Annotation[] =>
  Array.from({ length: n }, (_, i) => makeManualAnnotation(10 * i, 5, groupId, `${prefix}${i}`, at))
const automated = (): Annotation => ({ ...makeManualAnnotation(1, 1, 'g1', 'auto', at), origin: 'automated', lastEditSource: 'automated', geometry: { kind: 'circle', r: 12, source: 'fit' } })
const group = (over: Partial<AnnotationGroup> = {}): AnnotationGroup => ({ ...makeGroup([], 'g1'), ...over })

describe('seed selection', () => {
  it('uses only manual, accepted annotations of the target group, capped to the most recent', () => {
    const list = [...manual(2), automated(), ...manual(2, 'g2', 'x')]
    expect(seedAnnotations(list, 'g1').map((a) => a.id)).toEqual(['m0', 'm1'])
    const many = manual(MAX_SEEDS + 5)
    const seeds = seedAnnotations(many, 'g1')
    expect(seeds).toHaveLength(MAX_SEEDS)
    expect(seeds[0].id).toBe('m5')
    expect(seedAnnotations(undefined, 'g1')).toEqual([])
  })

  it('offers reference plates with enough examples, most first, skipping the current and changed images', () => {
    const images = [img('cur'), img('a'), img('b'), img('c', { sourceMismatch: { detectedAt: at, message: 'replaced' } }), img('d')]
    const docs = { cur: { annotations: manual(9) }, a: { annotations: manual(3) }, b: { annotations: manual(8) }, c: { annotations: manual(9) }, d: { annotations: manual(2) } }
    expect(referenceCandidates(images, docs, 'g1', 'cur')).toEqual([
      { imageId: 'b', name: 'b.jpg', count: 8 },
      { imageId: 'a', name: 'a.jpg', count: 3 },
    ])
    expect(referenceCandidates(images, docs, 'g2', 'cur')).toEqual([])
  })

  it('defaults to this image when it has enough examples, else to the best reference', () => {
    const cands = [{ imageId: 'b', name: 'b', count: 8 }]
    expect(defaultSeedSource(3, cands)).toEqual({ kind: 'this-image' })
    expect(defaultSeedSource(1, cands)).toEqual({ kind: 'reference', imageId: 'b' })
    expect(defaultSeedSource(0, [])).toEqual({ kind: 'this-image' })
  })
})

describe('find block', () => {
  const ok = { image: img('i1'), group: group(), sizeMismatch: false, localSeeds: 5, referenceCount: 0 }
  it('allows a normal image with examples', () => expect(findBlock(ok)).toBeNull())
  it('explains each reason in policy order', () => {
    expect(findBlock({ ...ok, image: null })?.reason).toBe('no-image')
    expect(findBlock({ ...ok, group: undefined })?.reason).toBe('no-group')
    expect(findBlock({ ...ok, group: group({ locked: true, hidden: true }) })?.reason).toBe('locked')
    expect(findBlock({ ...ok, group: group({ hidden: true }) })?.reason).toBe('hidden')
    expect(findBlock({ ...ok, image: img('i1', { sourceMismatch: { detectedAt: at, message: 'x' } }) })?.reason).toBe('source-mismatch')
    expect(findBlock({ ...ok, sizeMismatch: true })?.reason).toBe('size-mismatch')
    const none = findBlock({ ...ok, localSeeds: 0 })
    expect(none?.reason).toBe('no-seeds')
    expect(none?.message).toContain('Colonies')
    expect(findBlock({ ...ok, localSeeds: 0, referenceCount: 1 })).toBeNull()
  })
})

describe('request', () => {
  it('sends local seeds, every annotation as existing (with known radii) and reference seeds', () => {
    const anns = [...manual(3), automated(), ...manual(1, 'g2', 'o')]
    const req = buildRequest({
      image: img('i1'),
      groupId: 'g1',
      annotations: anns,
      reference: { image: img('ref', { width: 4000, height: 3000 }), annotations: manual(4, 'g1', 'r') },
      settings: { ...DEFAULT_REVIEW_SETTINGS, sensitivity: 0.7 },
      runId: 'run-1',
    })
    expect(req.seeds.map((s) => s.annotationId)).toEqual(['m0', 'm1', 'm2'])
    expect(req.seeds.every((s) => s.imageId === 'i1')).toBe(true)
    expect(req.existing).toHaveLength(5)
    expect(req.existing.find((e) => e.id === 'auto')).toMatchObject({ r: 12, origin: 'automated' })
    expect(req.remoteSeeds).toHaveLength(4)
    expect(req.remoteSeeds![0]).toMatchObject({ imageId: 'ref', imageWidth: 4000, imageHeight: 3000 })
    expect(req).toMatchObject({ originalWidth: 6000, originalHeight: 4000, targetGroupId: 'g1', runId: 'run-1', settings: { method: 'fitter', sensitivity: 0.7, priorWidth: 1 } })
  })
})
