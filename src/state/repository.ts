/**
 * The single place that chooses the ProjectRepository implementation: the real
 * storage (IndexedDB + Google Drive) when available, otherwise the in-memory
 * demo repository so the UI stays usable during development.
 */
import { createRepository } from '../storage'
import type { ProjectRepository } from '../storage/api'
import { createFakeRepository } from './fakeRepository'

export interface RepositoryChoice {
  repo: ProjectRepository
  /** True when the in-memory demo repository is in use (nothing persists). */
  isDemo: boolean
}

export function chooseRepository(): RepositoryChoice {
  const forceDemo = new URLSearchParams(globalThis.location?.search ?? '').has('demoStorage')
  if (!forceDemo) {
    try {
      return { repo: createRepository(), isDemo: false }
    } catch (err) {
      console.warn('[cfu-count] Real storage unavailable, using in-memory demo repository. Work will NOT persist.', err)
    }
  }
  return { repo: createFakeRepository(), isDemo: true }
}
