/**
 * Storage entry point. `createRepository()` wires the production collaborators;
 * tests use `createProjectRepository(deps)` with fakes instead.
 */
import type { ProjectRepository } from './api'
import { GisTokenProvider } from './drive/auth'
import { createDriveClient } from './drive/client'
import { readDriveConfig, type DriveEnv } from './drive/config'
import { GooglePicker } from './drive/picker'
import { DriveSession } from './drive/session'
import { browserDecoder } from './images'
import { LocalStore } from './localStore'
import { createProjectRepository } from './repository'

export { DriveError, LocalStorageError, SchemaError, isCancelled } from './errors'
export { ACCEPTED_IMAGE_MIME_TYPES } from './images'
export type { ProjectRepository } from './api'

export interface CreateRepositoryOptions {
  /** Override build-time env (tests / diagnostics). */
  env?: DriveEnv
  indexedDB?: IDBFactory
}

export function createRepository(opts: CreateRepositoryOptions = {}): ProjectRepository {
  const config = readDriveConfig(opts.env)
  const provider = config ? new GisTokenProvider(config) : null
  const picker = config ? new GooglePicker(config) : null
  const session = new DriveSession(provider)

  if (provider && picker && typeof window !== 'undefined') {
    // Load Google scripts early so "Connect" can open the consent popup synchronously
    // inside the click (Safari blocks popups opened after an await).
    void provider.preload().catch((e) => console.warn('[drive] Google sign-in unavailable:', (e as Error).message))
    void picker.preload().catch((e) => console.warn('[drive] Google Picker unavailable:', (e as Error).message))
  }

  return createProjectRepository({
    local: new LocalStore(opts.indexedDB ?? globalThis.indexedDB),
    decoder: browserDecoder,
    session,
    drive:
      config && picker
        ? {
            client: createDriveClient({ getToken: () => session.accessToken(), onUnauthorized: () => session.expire() }),
            picker,
          }
        : null,
  })
}
