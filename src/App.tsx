import { createEffect, createResource, on, onCleanup, onMount, Show } from 'solid-js'
import { createEditor } from './state/editor'
import { createAssist } from './state/assist'
import { createRegion } from './state/region'
import { createDetectorClient } from './detection/client'
import { chooseRepository, type RepositoryChoice } from './state/repository'
import { AppContext, type AppServices } from './ui/context'
import { createThumbnailCache } from './ui/images'
import { createDialogs, createToaster, type Toaster } from './ui/primitives'
import { createSoundSettings } from './state/soundSettings'
import { createSoundFeedback } from './ui/sound'
import { createProjectActions, VERSION_SAVED_DETAIL } from './ui/projectActions'
import { shouldWarnBeforeUnload } from './state/unload'
import { AppShell } from './ui/AppShell'

/** Composition root: chooses the repository (the demo one is a lazily loaded chunk), then builds the services once. */
export default function App() {
  const [choice] = createResource(() => chooseRepository())
  return <Show when={choice()}>{(c) => <AppRoot choice={c()} />}</Show>
}

function AppRoot(props: { choice: RepositoryChoice }) {
  const { repo, isDemo } = props.choice
  // Sound cues: per-device settings; the editor and assist report edit events through `feedback`.
  const soundSettings = createSoundSettings()
  const sound = createSoundFeedback({ settings: soundSettings.get })
  onCleanup(sound.dispose)
  const { feedback } = sound
  // Every toast also reaches feedback (error toasts play the error cue).
  const baseToaster = createToaster()
  const toaster: Toaster = {
    ...baseToaster,
    push(notice) {
      baseToaster.push(notice)
      feedback({ type: 'notice', tone: notice.tone })
    },
  }
  const dialogs = createDialogs()
  const editor = createEditor(repo, { notify: toaster.push, confirm: dialogs.confirm, feedback })
  onCleanup(editor.dispose)
  // One detector client (Worker) per app session, created on the first run.
  const assist = createAssist({ editor, notify: toaster.push, feedback, createClient: () => createDetectorClient() })
  onCleanup(assist.dispose)
  // Region selection (Region tool): shares the assist controller's detector worker.
  const thumbnails = createThumbnailCache(() => (editor.state.project ? editor.images.blob : null))
  // Thumbnails of Drive images fail while Drive is disconnected: retry once it connects.
  createEffect(on(() => editor.drive.state().state, (s) => s === 'connected' && thumbnails.retryFailed(), { defer: true }))
  const actions = createProjectActions(editor, dialogs, toaster.push)
  // Region selection (Region tool): shares the assist controller's detector worker.
  const region = createRegion({
    editor,
    assist,
    notify: toaster.push,
    feedback,
    beforeDestructive: (label) => editor.versions.beforeDestructive(label),
    versionSavedDetail: VERSION_SAVED_DETAIL,
  })
  onCleanup(region.dispose)
  const services: AppServices = {
    editor,
    assist,
    region,
    toaster,
    dialogs,
    thumbnails,
    actions,
    isDemo,
    sound: { settings: soundSettings, preview: sound.preview, status: sound.status },
  }

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
