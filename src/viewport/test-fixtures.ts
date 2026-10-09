/** Shared test fixtures for viewport unit tests (not used at runtime). */
import type { Annotation, AnnotationGroup } from '../model/types'

export function ann(id: string, x: number, y: number, groupId = 'g1'): Annotation {
  return {
    id,
    x,
    y,
    groupId,
    origin: 'manual',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    reviewStatus: 'accepted',
    lastEditSource: 'manual',
    manuallyAdjusted: false,
  }
}

export function group(id: string, over: Partial<AnnotationGroup> = {}): AnnotationGroup {
  return {
    id,
    name: id,
    color: '#e5484d',
    render: 'dot',
    opacity: 1,
    size: 6,
    labels: false,
    labelSize: 12,
    hidden: false,
    locked: false,
    ...over,
  }
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function randomAnnotations(n: number, w: number, h: number, seed = 1, groups = ['g1']): Annotation[] {
  const r = rng(seed)
  return Array.from({ length: n }, (_, i) => ann(`a${i}`, r() * w, r() * h, groups[i % groups.length]))
}
