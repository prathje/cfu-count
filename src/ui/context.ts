/**
 * App-level services, provided once by App and consumed ONLY by container
 * components (AppShell, WorkspaceContainer, SidebarContainer). Presentational
 * components receive data and callbacks through props instead.
 */
import { createContext, useContext } from 'solid-js'
import type { Editor } from '../state/editor'
import type { ThumbnailCache } from './images'
import type { Dialogs, Toaster } from './primitives'

export interface AppServices {
  editor: Editor
  toaster: Toaster
  dialogs: Dialogs
  thumbnails: ThumbnailCache
  /** True when the in-memory demo repository is active (nothing persists). */
  isDemo: boolean
}

export const AppContext = createContext<AppServices>()

export function useApp(): AppServices {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp() must be used inside <AppContext.Provider>')
  return ctx
}
