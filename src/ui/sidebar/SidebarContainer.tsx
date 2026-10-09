import { Show } from 'solid-js'
import { useApp } from '../context'
import { Sidebar } from './Sidebar'

/** Container: wires the image list (images, image groups, project name) to the editor. */
export function SidebarContainer() {
  const { editor, thumbnails, actions } = useApp()
  const { state, images, imageGroups } = editor
  const driveConnected = () => editor.drive.state().state === 'connected'
  return (
    <Show when={state.project}>
      {(project) => (
        <Sidebar
          project={project()}
          currentImageId={state.currentImageId}
          importing={state.importing}
          driveConnected={driveConnected()}
          imageCount={images.confirmedCount}
          thumbnail={thumbnails.url}
          requestThumbnail={thumbnails.request}
          onSelectImage={images.select}
          onImportFiles={(gid) => void actions.chooseImages(gid)}
          onImportDrive={(gid) => void images.importFromDrive(gid)}
          onRenameProject={editor.projects.rename}
          onCreateImageGroup={() => imageGroups.create()}
          onRenameImageGroup={imageGroups.rename}
          onDeleteImageGroup={(id) => void actions.deleteImageGroup(id)}
          onMoveImageGroup={imageGroups.move}
          onAssignImage={images.assign}
          onRenameImage={(id) => void actions.renameImage(id)}
          onRemoveImage={(id) => void actions.removeImage(id)}
        />
      )}
    </Show>
  )
}
