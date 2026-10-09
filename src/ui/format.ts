/** Pure presentation helpers (labels, numbers). */
import type { DriveState, SaveStatus } from '../storage/api'

export type StatusTone = 'neutral' | 'ok' | 'busy' | 'warn' | 'error'

/** Distinct, human label + tone for every SaveStatus state. */
export function saveStatusLabel(s: SaveStatus): { label: string; tone: StatusTone; detail: string } {
  switch (s.state) {
    case 'idle':
      return { label: 'No project open', tone: 'neutral', detail: 'Open or create a project to start.' }
    case 'saved-local':
      return { label: 'Saved locally', tone: 'ok', detail: `Saved in this browser${timeSuffix(s.at)}.` }
    case 'local-error':
      return { label: 'Local storage error', tone: 'error', detail: `This browser refused to store your changes: ${s.message}` }
    case 'pending':
      return { label: 'Changes pending', tone: 'warn', detail: 'Saved in this browser; not yet on Google Drive.' }
    case 'saving-drive':
      return { label: 'Saving to Drive', tone: 'busy', detail: 'Uploading changes to Google Drive…' }
    case 'saved-drive':
      return { label: 'Saved to Drive', tone: 'ok', detail: `Saved in this browser and on Google Drive${timeSuffix(s.at)}.` }
    case 'reconnect-required':
      return { label: 'Reconnect required', tone: 'warn', detail: 'Your Google session expired. Changes are safe in this browser — reconnect to save to Drive.' }
    case 'failed':
      return { label: 'Save failed', tone: 'error', detail: `Couldn’t save to Google Drive: ${s.message} Your changes are safe in this browser.` }
    case 'conflict':
      return { label: 'Conflict needs review', tone: 'error', detail: 'The Drive copy changed since this browser last read it.' }
  }
}

export function driveLabel(d: DriveState): string {
  switch (d.state) {
    case 'unconfigured':
      return 'Drive not set up'
    case 'disconnected':
      return 'Connect Drive'
    case 'connecting':
      return 'Connecting…'
    case 'connected':
      return 'Google Drive'
    case 'expired':
      return 'Reconnect Drive'
  }
}

function timeSuffix(iso: string): string {
  const t = formatTime(iso)
  return t ? ` at ${t}` : ''
}

export function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export function formatRelativeDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const sameDay = new Date().toDateString() === d.toDateString()
  return sameDay ? `Today ${formatTime(iso)}` : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`

export const formatCount = (n: number) => n.toLocaleString()
