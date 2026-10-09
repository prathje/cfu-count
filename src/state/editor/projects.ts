/** Project lifecycle: list, open, create, import/export, rename, delete, flush. */
import type { ID } from '../../model/types'
import type { ProjectSession } from '../../storage/api'
import { isNotProjectArchive } from '../../storage/errors'
import { prefs } from '../prefs'
import type { EditorContext } from './context'

export interface ProjectCommands {
  /** Load the project list and open the last-used project. */
  init(): Promise<void>
  refresh(): Promise<void>
  /** Switching projects first saves pending edits; if that fails the user is asked before anything is discarded. */
  open(id: ID): Promise<boolean>
  create(name: string): Promise<boolean>
  importArchive(file: File): Promise<boolean>
  rename(name: string): void
  /** Delete the browser copy (Drive is never touched); opens the most recent remaining project. */
  remove(id: ID): Promise<void>
  exportArchive(): Promise<Blob | undefined>
  exportCsv(): Promise<Blob | undefined>
  /** Persist pending changes now (visibilitychange / pagehide). Resolves true when everything is saved. */
  flush(): Promise<boolean>
}

export function createProjects(ctx: EditorContext): ProjectCommands {
  const { state, setState, repo, notify } = ctx

  async function refresh() {
    try {
      setState('projects', await repo.list())
    } catch (err) {
      notify({ tone: 'error', message: 'Couldn’t read projects stored in this browser', detail: err instanceof Error ? err.message : String(err) })
    }
  }

  const byRecent = () => [...state.projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

  async function init() {
    await refresh()
    const last = prefs.get<string | null>('lastProject', null)
    const target = byRecent().find((p) => p.id === last) ?? byRecent()[0]
    if (target) {
      const session = await ctx.run('Opening project…', () => repo.open(target.id), 'Couldn’t open project', { blocking: true })
      if (session) {
        ctx.load(session)
        return
      }
    }
    setState('phase', 'empty')
  }

  /** Replace the open project with the session `fn` produces (after guarding unsaved edits). */
  async function switchTo(action: string, label: string, failMessage: string, fn: () => Promise<ProjectSession | null>): Promise<boolean> {
    if (!(await ctx.guardUnsaved(action))) return false
    const session = await ctx.run(label, fn, failMessage, { blocking: true })
    if (!session) return false
    ctx.load(session)
    await refresh()
    return true
  }

  async function exportWith(label: string, failMessage: string, fn: (s: ProjectSession) => Promise<Blob>) {
    const session = ctx.session()
    if (!session) return undefined
    if (!(await ctx.saver.flush())) {
      notify({ tone: 'warning', message: 'Your latest changes aren’t saved yet', detail: 'The download contains the last saved state.' })
    }
    return ctx.run(label, () => fn(session), failMessage)
  }

  return {
    init,
    refresh,
    open: (id) => switchTo('Opening another project', 'Opening project…', 'Couldn’t open project', () => repo.open(id)),
    create: (name) =>
      switchTo('Creating a project', 'Creating project…', 'Couldn’t create project', () => repo.create(name.trim() || 'Untitled project')),
    importArchive: (file) =>
      switchTo('Importing a project', 'Importing project…', 'Couldn’t import that project file', async () => {
        try {
          return await repo.importArchive(file)
        } catch (err) {
          if (!isNotProjectArchive(err)) throw err
          // Not a project archive: plain-language notice; the technical reason goes to the console.
          console.warn(`Archive import rejected (${file.name}):`, err)
          notify({
            tone: 'error',
            key: 'import-archive',
            message: 'This file isn’t a CFU Count project',
            detail: `Choose a .zip made with Download project. (${file.name})`,
          })
          return null
        }
      }),
    rename(name) {
      const trimmed = name.trim()
      const project = state.project
      if (!project || !trimmed || trimmed === project.name || ctx.editsFrozen()) return
      setState('project', 'name', trimmed)
      setState('projects', (p) => p.id === project.id, 'name', trimmed)
      ctx.touchProject()
    },
    async remove(id) {
      const isOpen = state.project?.id === id
      // Deleting the open project discards its pending edits on purpose.
      if (isOpen) ctx.saver.reset()
      const ok = await ctx.run('Deleting project…', () => repo.delete(id).then(() => true), 'Couldn’t delete project', { blocking: isOpen })
      if (!ok) return
      if (isOpen) {
        ctx.unload()
        prefs.set('lastProject', null)
      }
      await refresh()
      const next = isOpen ? byRecent()[0] : undefined
      if (next) await switchTo('Opening another project', 'Opening project…', 'Couldn’t open project', () => repo.open(next.id))
    },
    exportArchive: () => exportWith('Preparing download…', 'Couldn’t create the project download', (s) => s.exportZip()),
    exportCsv: () => exportWith('Preparing CSV…', 'Couldn’t create the CSV summary', (s) => s.exportCsv()),
    flush: () => ctx.saver.flush(),
  }
}
