/**
 * Contract for the image viewport component (src/viewport). It is a pure view +
 * input component: it never mutates annotations itself; it reports intents.
 */
import type { Annotation, AnnotationGroup, ID } from '../model/types'
import type { EditBlockReason } from '../model/policy'
import type { Tool } from '../model/tool'

export type { Tool } from '../model/tool'

/** Why a tap did nothing: the shared edit policy (model/policy.ts) or an erase that hit no marker. */
export type BlockedReason = EditBlockReason | 'nothing-to-erase'

export interface ViewState {
  /** Screen CSS px per image px. */
  scale: number
  /** Image coordinate shown at the viewport's top-left corner. */
  offsetX: number
  offsetY: number
}

export interface ViewportHandle {
  zoomIn(): void
  zoomOut(): void
  fit(): void
  /** Zoom to an absolute scale anchored at the viewport centre. */
  setScale(scale: number): void
}

export interface ViewportProps {
  /** Decoded image; null while loading. */
  image: ImageBitmap | HTMLImageElement | null
  imageWidth: number
  imageHeight: number
  /**
   * Annotations to draw, as an IMMUTABLE snapshot: plain objects (not store proxies)
   * in an array that is replaced whenever anything changes. The viewport redraws and
   * re-indexes when the array identity changes and never reads fields reactively.
   */
  annotations: readonly Annotation[]
  /**
   * All annotation groups in display order (style, hidden, locked live here). Same
   * contract as `annotations`: an immutable snapshot whose identity changes on change.
   */
  groups: readonly AnnotationGroup[]
  activeGroupId: ID | null
  tool: Tool
  /**
   * Allow single-finger touch to annotate. When false (default) finger touch only
   * navigates and pen/mouse annotate; becomes true automatically is NOT done here.
   */
  touchAnnotates: boolean
  /** Completed tap/click in Add mode, in image coordinates. */
  onAdd(x: number, y: number): void
  /** Completed tap/click in Erase mode that hit an eligible marker. */
  onErase(annotationId: ID): void
  /** Tap in add/erase on a hidden or locked active group, or erase that hit nothing. */
  onBlocked?(reason: BlockedReason): void
  onViewChange?(view: ViewState): void
  ref?: (handle: ViewportHandle) => void
  /** Optional aria label / description for the canvas. */
  label?: string
  /**
   * Screen areas (CSS px) covered by overlaid UI (floating toolbar, zoom footer).
   * Fit and auto-fit contain the image within the viewport minus these insets.
   */
  fitInsets?: { top: number; right: number; bottom: number; left: number }
}
