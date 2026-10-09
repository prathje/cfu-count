import { onMount } from 'solid-js'
import { createEditor } from './state/editor'
import { chooseRepository } from './state/repository'
import { AppContext, type AppServices } from './ui/context'
import { createThumbnailCache } from './ui/images'
import { createDialogs, createToaster } from './ui/primitives'
import { AppShell } from './ui/AppShell'

/** Composition root: builds the repository, editor and UI services once. */
export default function App() {
  const { repo, isDemo } = chooseRepository()
  const toaster = createToaster()
  const dialogs = createDialogs()
  const editor = createEditor(repo, toaster.push)
  const thumbnails = createThumbnailCache(() => (editor.state.project ? editor.getImageBlob : null))
  const services: AppServices = { editor, toaster, dialogs, thumbnails, isDemo }

  onMount(() => void editor.init())

  return (
    <AppContext.Provider value={services}>
      <AppShell dialogHost={dialogs} />
    </AppContext.Provider>
  )
}
