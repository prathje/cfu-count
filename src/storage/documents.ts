/** Serialisation helpers shared by the archive codec and the Drive sync engine. */
import type { Project } from '../model/types'
import type { DriveFiles } from './localStore'

/**
 * project.json as written to shared locations (Drive folder, .zip). Strips the
 * signed-in account (private, browser-local). For a Drive folder, `files` adds
 * the output file IDs (without this browser's content tokens) so another
 * device or user under the narrow drive.file scope can find and request access
 * to them; readers treat them as hints only.
 */
export function toSharedProject(project: Project, files?: DriveFiles): unknown {
  if (project.storage.kind !== 'drive') return project
  const { account: _account, ...link } = project.storage
  void _account
  if (!files) return { ...project, storage: link }
  const { remoteVersions: _rv, ...ids } = files
  void _rv
  return { ...project, storage: { ...link, files: ids } }
}

export function encodeJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n'
}

export const utf8 = {
  encode: (s: string): Uint8Array => new TextEncoder().encode(s),
  decode: (b: Uint8Array): string => new TextDecoder('utf-8', { fatal: false }).decode(b),
}
