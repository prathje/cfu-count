/** Serialisation helpers shared by the archive codec and the Drive sync engine. */
import type { Project } from '../model/types'

/**
 * The project as written to shared locations (Drive folder, .zip). Strips
 * browser-local data: the signed-in account and this browser's remote content
 * tokens, which are meaningless (and private) elsewhere.
 */
export function toSharedProject(project: Project): Project {
  if (project.storage.kind !== 'drive') return project
  const { account: _account, ...link } = project.storage
  void _account
  return { ...project, storage: { ...link, remoteVersions: {} } }
}

export function encodeJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n'
}

export const utf8 = {
  encode: (s: string): Uint8Array => new TextEncoder().encode(s),
  decode: (b: Uint8Array): string => new TextDecoder('utf-8', { fatal: false }).decode(b),
}
