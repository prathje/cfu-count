import { createResource, onCleanup, onMount, Show } from 'solid-js'
import { createEditor } from './state/editor'
import { createAssist } from './state/assist'
import { createDetectorClient } from './detection/client'
import { chooseRepository, type RepositoryChoice } from './state/repository'
import { AppContext, type AppServices } from './ui/context'
import { createThumbnailCache } from './ui/images'
import { createDialogs, createToaster } from './ui/primitives'
import { createProjectActions } from './ui/projectActions'
import { shouldWarnBeforeUnload } from './state/unload'
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
  // One detector client (Worker) per app session, created on the first run.
  const assist = createAssist({ editor, notify: toaster.push, createClient: () => createDetectorClient() })
  onCleanup(assist.dispose)
  const thumbnails = createThumbnailCache(() => (editor.state.project ? editor.images.blob : null))
  const actions = createProjectActions(editor, dialogs, thumbnails, toaster.push)
  const services: AppServices = { editor, assist, toaster, dialogs, thumbnails, actions, isDemo }

  onMount(() => void editor.projects.init())

  // Warn before closing the tab only when local work is at risk (state/unload.ts).
  const onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (!shouldWarnBeforeUnload({ status: editor.saveStatus(), saveFailed: editor.saveFailed(), dirtySince: editor.dirtySince(), now: Date.now() })) return
    e.preventDefault()
    e.returnValue = '' // older Safari / Chrome need returnValue set
  }
  window.addEventListener('beforeunload', onBeforeUnload)
  onCleanup(() => window.removeEventListener('beforeunload', onBeforeUnload))

  return (
    <AppContext.Provider value={services}>
      <AppShell />
    </AppContext.Provider>
  )
}
