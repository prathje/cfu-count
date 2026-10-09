/**
 * App-level services, provided once by App and consumed ONLY by container
 * components (AppShell, WorkspaceContainer, SidebarContainer) and container
 * hooks (createProjectActions). Presentational components receive data and
 * callbacks through props instead.
 */
import { createContext, useContext } from 'solid-js'
import type { Editor } from '../state/editor'
import type { Assist } from '../state/assist'
import type { RegionController } from '../state/region'
import type { ThumbnailCache } from './images'
import type { DialogController, Toaster } from './primitives'
import type { ProjectActions } from './projectActions'
import type { Cue } from '../state/feedback'
import type { SoundSettingsStore } from '../state/soundSettings'
import type { AudioStatus } from './sound'

export interface AppServices {
  editor: Editor
  /** Assisted counting ("Find similar"): one detector worker and the in-memory suggestions. */
  assist: Assist
  /** Region selection (Region tool): per-image polygon, clear / find similar / compare in region. */
  region: RegionController
  toaster: Toaster
  dialogs: DialogController
  thumbnails: ThumbnailCache
  /** Dialog-wrapped project actions shared by containers. */
  actions: ProjectActions
  /** True when the in-memory demo repository is active (nothing persists). */
  isDemo: boolean
  /** Sound feedback settings (per device) and a preview for the settings menu. */
  sound: {
    settings: SoundSettingsStore
    preview(cue: Cue): void
    status(): AudioStatus
  }
}

export const AppContext = createContext<AppServices>()

export function useApp(): AppServices {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp() must be used inside <AppContext.Provider>')
  return ctx
}
