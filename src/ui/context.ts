/**
 * App-level services, provided once by App and consumed ONLY by container
 * components (AppShell, WorkspaceContainer, SidebarContainer) and container
 * hooks (createProjectActions). Presentational components receive data and
 * callbacks through props instead.
 */
import { createContext, useContext } from 'solid-js'
import type { Editor } from '../state/editor'
import type { ThumbnailCache } from './images'
import type { DialogController, Toaster } from './primitives'
import type { ProjectActions } from './projectActions'

export interface AppServices {
  editor: Editor
  toaster: Toaster
  dialogs: DialogController
  thumbnails: ThumbnailCache
  /** Dialog-wrapped project actions shared by containers. */
  actions: ProjectActions
  /** True when the in-memory demo repository is active (nothing persists). */
  isDemo: boolean
}

export const AppContext = createContext<AppServices>()

export function useApp(): AppServices {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp() must be used inside <AppContext.Provider>')
  return ctx
}
