import { createEffect, createMemo, createResource, createSignal, on } from 'solid-js'
import { unwrap } from 'solid-js/store'
import type { ID } from '../../model/types'
import type { VersionInfo } from '../../storage/api'
import { useApp } from '../context'
import { createMediaQuery } from '../media'
import { currentCounts, imageRows, restoreSummary, versionDateTime } from './versionView'
import { VersionHistoryDialog } from './VersionHistoryDialog'

/** Wires the Version history dialog to the editor's versions slice. */
export function VersionHistoryContainer() {
  const { editor, actions, dialogs } = useApp()
  const { state, versions } = editor
  const phone = createMediaQuery('(max-width: 560px)')
  const open = () => actions.versionHistoryOpen() && !!state.project
  const [selectedId, setSelectedId] = createSignal<ID | null>(null)

  // Reload the list whenever it is opened or versions change (new, deleted, restored).
  const [list] = createResource(
    () => (open() ? { project: state.project!.id, n: versions.changes() } : false),
    () => versions.list(),
  )
  const shown = () => (list.loading && !list.latest ? null : (list.latest ?? null))

  // Wide screens preselect the newest version; a vanished selection is cleared.
  createEffect(
    on([shown, phone], ([vs, isPhone]) => {
      if (!vs) return
      const id = selectedId()
      if (id && vs.some((v) => v.id === id)) return
      setSelectedId(isPhone ? null : (vs[0]?.id ?? null))
    }),
  )
  createEffect(on(open, (o) => !o && setSelectedId(null), { defer: true }))

  const [snapshot] = createResource(
    () => (open() && selectedId() ? { id: selectedId()!, n: versions.changes() } : false),
    ({ id }) => versions.load(id),
  )
  const now = createMemo(() => (state.project ? currentCounts(state.project, state.docs) : { annotations: 0, images: 0, byGroup: new Map() }))
  const rows = createMemo(() => {
    const snap = snapshot.latest
    if (!snap || !state.project || snapshot.loading) return null
    return imageRows(snap, unwrap(state.project), unwrap(state.docs))
  })

  async function restore(v: VersionInfo) {
    const r = rows()
    const ok = await dialogs.confirm({
      title: `Restore the version from ${versionDateTime(v)}?`,
      body: `“${v.label}”. ${r ? restoreSummary(r) + ' ' : ''}The project as it is now is saved as a version first, so you can undo this. Undo history of each image starts over.`,
      confirmLabel: 'Restore this version',
    })
    if (!ok) return
    if (await versions.restore(v.id)) actions.closeVersionHistory()
  }

  async function restoreImage(v: VersionInfo, imageId: ID) {
    const img = state.project?.images.find((i) => i.id === imageId)
    if (!img) return
    const ok = await dialogs.confirm({
      title: `Restore “${img.name}” from ${versionDateTime(v)}?`,
      body: 'Its annotations are replaced with the ones in this version; other images are not changed. Undo works on this image.',
      confirmLabel: 'Restore this image',
    })
    if (!ok) return
    if (await versions.restoreImage(v.id, imageId)) {
      actions.closeVersionHistory()
      if (state.currentImageId !== imageId) editor.images.select(imageId)
    }
  }

  async function remove(v: VersionInfo) {
    const ok = await dialogs.confirm({
      title: 'Delete this version?',
      body: `The version from ${versionDateTime(v)} is removed from this browser. The project itself is not changed.`,
      confirmLabel: 'Delete version',
      danger: true,
    })
    if (ok) await versions.remove(v.id)
  }

  return (
    <VersionHistoryDialog
      open={open()}
      phone={phone()}
      versions={shown()}
      project={state.project}
      now={now()}
      selectedId={selectedId()}
      imageRows={rows()}
      previewLoading={snapshot.loading}
      driveLinked={state.project?.storage.kind === 'drive'}
      busy={!!state.busy}
      onSelect={setSelectedId}
      onSaveNow={() => void versions.saveNow()}
      onRestore={(v) => void restore(v)}
      onRestoreImage={(v, id) => void restoreImage(v, id)}
      onDelete={(v) => void remove(v)}
      onClose={actions.closeVersionHistory}
    />
  )
}
