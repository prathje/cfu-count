import { describe, expect, it } from 'vitest'
import { acceptTerms, hasAcceptedTerms, TERMS_VERSION, type TermsStore } from './terms'

function memoryStore(): TermsStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    data,
    get: <T,>(k: string, fallback: T) => (data.has(k) ? (data.get(k) as T) : fallback),
    set: (k, v) => void data.set(k, v),
  }
}

describe('terms of use acceptance', () => {
  it('is not accepted on a fresh browser and is remembered after accepting', () => {
    const s = memoryStore()
    expect(hasAcceptedTerms(s)).toBe(false)
    acceptTerms(s, new Date('2026-10-09T12:00:00Z'))
    expect(hasAcceptedTerms(s)).toBe(true)
    expect(s.data.get('terms')).toEqual({ version: TERMS_VERSION, acceptedAt: '2026-10-09T12:00:00.000Z' })
  })

  it('asks again when the terms version increases or the stored value is malformed', () => {
    const s = memoryStore()
    s.set('terms', { version: TERMS_VERSION - 1, acceptedAt: 'x' })
    expect(hasAcceptedTerms(s)).toBe(false)
    s.set('terms', 'yes')
    expect(hasAcceptedTerms(s)).toBe(false)
  })
})
