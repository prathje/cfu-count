/**
 * The single place that chooses the ProjectRepository implementation: the real
 * storage (IndexedDB + Google Drive), or the in-memory demo repository when the
 * page is opened with `?demoStorage` or the real storage cannot start.
 *
 * The demo repository (and its sample-plate drawing code) is loaded with a
 * dynamic import, so it is a separate chunk that production users never
 * download unless one of those two cases happens. `?demoStorage` keeps working
 * in production builds on purpose: it is the zero-setup way to demo the app.
 */
import { createRepository } from '../storage'
import type { ProjectRepository } from '../storage/api'

export interface RepositoryChoice {
  repo: ProjectRepository
  /** True when the in-memory demo repository is in use (nothing persists). */
  isDemo: boolean
}

export async function chooseRepository(search = globalThis.location?.search ?? ''): Promise<RepositoryChoice> {
  const forceDemo = new URLSearchParams(search).has('demoStorage')
  if (!forceDemo) {
    try {
      return { repo: createRepository(), isDemo: false }
    } catch (err) {
      console.warn('[cfu-count] Real storage unavailable, using in-memory demo repository. Work will NOT persist.', err)
    }
  }
  const { createDemoRepository } = await import('../demo/demoRepository')
  return { repo: createDemoRepository(), isDemo: true }
}
