import { createResource, onCleanup, onMount, Show } from 'solid-js'
import { createEditor } from './state/editor'
import { chooseRepository, type RepositoryChoice } from './state/repository'
import { AppContext, type AppServices } from './ui/context'
import { createThumbnailCache } from './ui/images'
import { createDialogs, createToaster } from './ui/primitives'
import { createProjectActions } from './ui/projectActions'
import { AppShell } from './ui/AppShell'

/** Composition root: chooses the repository (the demo one is a lazily loaded chunk), then builds the services once. */
export default function App() {
  const [choice] = createResource(() => chooseRepository())
  return <Show when={choice()}>{(c) => <AppRoot choice={c()} />}</Show>
}

function AppRoot(props: { choice: RepositoryChoice }) {
  const { repo, isDemo } = props.choice
  const toaster = createToaster()
  const dialogs = createDialogs()
  const editor = createEditor(repo, { notify: toaster.push, confirm: dialogs.confirm })
  onCleanup(editor.dispose)
  const thumbnails = createThumbnailCache(() => (editor.state.project ? editor.images.blob : null))
  const actions = createProjectActions(editor, dialogs, thumbnails)
  const services: AppServices = { editor, toaster, dialogs, thumbnails, actions, isDemo }

  onMount(() => void editor.projects.init())

  return (
    <AppContext.Provider value={services}>
      <AppShell />
    </AppContext.Provider>
  )
}
