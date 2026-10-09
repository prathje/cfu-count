/**
 * summary.csv codec (pure). One row per image × annotation group, including
 * zero-count groups. JSON annotation documents remain the source of truth.
 *
 * Count rules (documented in docs/schema.md; computed by model/annotations.ts, the same
 * `isConfirmed` the UI uses):
 *   manual_count               annotations with origin "manual" (always confirmed)
 *   automated_accepted_count   origin "automated" with reviewStatus "accepted"
 *   automated_unreviewed_count origin "automated" with reviewStatus "unreviewed" (suggestions)
 *   confirmed_count            manual_count + automated_accepted_count
 * Automated annotations with reviewStatus "rejected" are not counted anywhere.
 * Hidden/locked are reported as metadata and never change counts.
 * Images the user removed (ImageRecord.deletedAt) get no rows: they are not part of
 * the project's results until restored. Their records and annotations stay in
 * project.json and annotations/.
 */
import type { AnnotationGroup, ID, ImageAnnotations, Project } from '../model/types'
import { countBreakdownByGroup, emptyBreakdown } from '../model/annotations'
import { activeImages } from '../model/project'

export const CSV_COLUMNS = [
  'project_id',
  'project_name',
  'image_group_id',
  'image_group_name',
  'image_id',
  'image_name',
  'drive_file_id',
  'annotation_group_id',
  'annotation_group_name',
  'confirmed_count',
  'manual_count',
  'automated_accepted_count',
  'automated_unreviewed_count',
  'group_hidden',
  'group_locked',
  'image_width',
  'image_height',
  'image_fingerprint_sha256',
  'annotations_updated_at',
] as const

type Cell = string | number | boolean

/**
 * Prevent spreadsheet formula injection (OWASP): text starting with = + - @ TAB or
 * CR is prefixed with a single quote so it is shown literally.
 */
export function neutraliseFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
}

/** RFC 4180 field encoding. Numbers/booleans are emitted verbatim; text is formula-neutralised. */
export function encodeCell(value: Cell): string {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  const s = neutraliseFormula(value)
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s
}

export function encodeRow(cells: Cell[]): string {
  return cells.map(encodeCell).join(',')
}

/** Build summary rows (without header). Exposed for tests and UI previews. */
export function summaryRows(project: Project, annotations: Map<ID, ImageAnnotations>): Cell[][] {
  const groupNames = new Map(project.imageGroups.map((g) => [g.id, g.name]))
  const rows: Cell[][] = []
  for (const image of activeImages(project)) {
    const doc = annotations.get(image.id)
    const counts = countBreakdownByGroup(doc?.annotations)
    // Project groups first (display order), then groups only known to this document
    // so no annotation silently disappears from the summary.
    const groups: AnnotationGroup[] = [...project.annotationGroups]
    const known = new Set(groups.map((g) => g.id))
    for (const id of counts.keys()) {
      if (known.has(id)) continue
      const snap = doc?.groups.find((g) => g.id === id)
      groups.push(snap ?? { id, name: '(unknown group)', color: '', render: 'dot', opacity: 1, size: 1, labels: false, labelSize: 12, hidden: false, locked: false })
      known.add(id)
    }
    for (const g of groups) {
      const c = counts.get(g.id) ?? emptyBreakdown()
      rows.push([
        project.id,
        project.name,
        image.imageGroupId ?? '',
        image.imageGroupId ? groupNames.get(image.imageGroupId) ?? '' : '',
        image.id,
        image.name,
        image.source.kind === 'drive' ? image.source.fileId : '',
        g.id,
        g.name,
        c.confirmed,
        c.manual,
        c.automatedAccepted,
        c.automatedUnreviewed,
        g.hidden,
        g.locked,
        image.width,
        image.height,
        image.fingerprint,
        doc?.updatedAt ?? '',
      ])
    }
  }
  return rows
}

/** UTF-8 text with BOM (so Excel detects the encoding) and CRLF line endings. */
export function buildSummaryCsv(project: Project, annotations: Map<ID, ImageAnnotations>): string {
  const lines = [encodeRow([...CSV_COLUMNS]), ...summaryRows(project, annotations).map(encodeRow)]
  return '﻿' + lines.join('\r\n') + '\r\n'
}

/** Minimal RFC 4180 parser (used by tests and for verifying round trips). */
export function parseCsv(text: string): string[][] {
  const src = text.startsWith('﻿') ? text.slice(1) : text
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += ch
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}
