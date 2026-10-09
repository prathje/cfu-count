/**
 * Google Drive commands. Every command that may need sign-in starts it
 * synchronously (ctx.ensureDriveAuth / the session's Drive methods) before its
 * first await, so Safari allows the popup.
 */
import type { Accessor } from 'solid-js'
import type { DriveLinkMode, DriveState } from '../../storage/api'
import { isCancelled } from '../../storage/errors'
import { errorText, type EditorContext } from './context'

export interface DriveCommands {
  state: Accessor<DriveState>
  connect(): Promise<void>
  disconnect(): Promise<void>
  /** Link the open (local) project to a folder and upload it. Editing continues meanwhile. */
  link(mode: DriveLinkMode): Promise<void>
  /** Open a Drive folder as a project (guards unsaved edits of the open project). */
  openFolder(): Promise<boolean>
  /** Save to Drive now; `overwrite` resolves a conflict in favour of this browser's copy. */
  save(overwrite?: boolean): Promise<void>
  /** Resolve a conflict in favour of Drive (local copy kept as a backup project by storage). */
  takeRemote(): Promise<void>
}

export function createDrive(ctx: EditorContext, driveState: Accessor<DriveState>, afterOpen: () => Promise<void>): DriveCommands {
  const { state, notify, saver } = ctx

  /** Sign-in (sync start) + local flush in parallel; resolves false if sign-in failed or was cancelled. */
  async function authAndFlush(auth: Promise<void>): Promise<boolean> {
    try {
      await Promise.all([auth, saver.flush()])
      return true
    } catch (err) {
      if (!isCancelled(err)) notify({ tone: 'error', message: 'Couldn’t connect to Google Drive', detail: errorText(err) })
      return false
    }
  }

  return {
    state: driveState,

    async connect() {
      try {
        await ctx.repo.connectDrive()
      } catch (err) {
        if (isCancelled(err)) return
        notify({ tone: 'error', message: 'Couldn’t connect to Google Drive', detail: errorText(err) })
      }
    },

    async disconnect() {
      try {
        await ctx.repo.disconnectDrive()
      } catch (err) {
        notify({ tone: 'error', message: 'Couldn’t disconnect Google Drive', detail: errorText(err) })
      }
    },

    async link(mode) {
      const session = ctx.session()
      if (!session) return
      if (!(await authAndFlush(ctx.ensureDriveAuth()))) return
      // Not blocking: storage reports the link and uploaded image sources through
      // onUpdated, which merges only storage-owned fields; edits made meanwhile survive.
      const result = await ctx.run('Linking to Google Drive…', () => session.drive.link(mode), 'Couldn’t link the project to Google Drive')
      if (!result) return
      if (result.warnings.length) notify({ tone: 'warning', message: 'Linked with a warning', detail: result.warnings.join(' · ') })
      else if (state.project?.storage.kind === 'drive') notify({ tone: 'success', message: `Linked to Drive folder “${state.project.storage.folderName}”` })
    },

    async openFolder() {
      const auth = ctx.ensureDriveAuth()
      try {
        await auth
      } catch (err) {
        if (!isCancelled(err)) notify({ tone: 'error', message: 'Couldn’t connect to Google Drive', detail: errorText(err) })
        return false
      }
      if (!(await ctx.guardUnsaved('Opening a Drive folder'))) return false
      const session = await ctx.run('Opening from Google Drive…', () => ctx.repo.openFromDrive(), 'Couldn’t open the project from Google Drive', { blocking: true })
      if (!session) return false
      ctx.load(session)
      await afterOpen()
      return true
    },

    async save(overwrite = false) {
      const session = ctx.session()
      if (!session) return
      if (!(await authAndFlush(ctx.ensureDriveAuth()))) return
      await ctx.run('Saving to Google Drive…', () => session.drive.push({ overwrite }), 'Couldn’t save to Google Drive')
    },

    async takeRemote() {
      const session = ctx.session()
      if (!session) return
      const auth = ctx.ensureDriveAuth()
      try {
        await auth
      } catch (err) {
        if (!isCancelled(err)) notify({ tone: 'error', message: 'Couldn’t connect to Google Drive', detail: errorText(err) })
        return
      }
      // Unsaved edits would not be in the backup copy: save them first, or ask.
      if (!(await ctx.guardUnsaved('Loading the Drive version'))) return
      // Freeze: no autosave and no edits until the Drive version is loaded.
      saver.suspend()
      try {
        const snapshot = await ctx.run('Loading the Drive version…', () => session.drive.takeRemote(), 'Couldn’t load the Drive version', { blocking: true })
        if (!snapshot) return
        ctx.load(session, snapshot)
        await afterOpen()
        notify({ tone: 'success', message: 'Loaded the Drive version', detail: 'Your local copy was kept as a backup project.' })
      } finally {
        saver.resume()
      }
    },
  }
}
