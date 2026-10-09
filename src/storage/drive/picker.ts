/**
 * Google Picker (https://developers.google.com/workspace/drive/picker/guides/web-picker).
 *
 * Under the drive.file scope, picking an item is what grants this app access to
 * it. Picking a FOLDER grants access to the folder itself (list it, create files
 * in it) but NOT to existing files inside it; those must be picked individually
 * (pickFiles with parentId, or fileIds to pre-select known IDs).
 */
import { DriveError } from '../errors'
import type { DriveConfig } from './config'
import { loadScript } from './scripts'

/** One item the user picked. */
export interface PickedItem {
  id: string
  name: string
  mimeType: string
  parentId?: string
}

/** Options for a file picker dialog. */
export interface PickFilesOptions {
  title: string
  /** Open in this folder (subfolders remain navigable). Ignored when fileIds is set. */
  parentId?: string
  /** Show only these files (granting access to known IDs). */
  fileIds?: string[]
  mimeTypes?: string[]
  multiselect?: boolean
  /** Allow folders to be selected too (granting access to a known subfolder). */
  allowFolders?: boolean
}

/** Folder/file chooser. Implementations open UI; `[]`/`null` means cancelled. */
export interface DrivePicker {
  pickFolder(token: string, opts: { title: string }): Promise<PickedItem | null>
  pickFiles(token: string, opts: PickFilesOptions): Promise<PickedItem[]>
}

// --- minimal google.picker typings ---
interface PickerNs {
  ViewId: { DOCS: string; FOLDERS: string }
  Feature: { MULTISELECT_ENABLED: string; SUPPORT_DRIVES: string }
  Action: { PICKED: string; CANCEL: string }
  DocsViewMode: { LIST: string; GRID: string }
  DocsView: new (viewId?: string) => DocsView
  PickerBuilder: new () => PickerBuilder
}
interface DocsView {
  setIncludeFolders(b: boolean): DocsView
  setSelectFolderEnabled(b: boolean): DocsView
  setMimeTypes(m: string): DocsView
  setParent(id: string): DocsView
  setFileIds(ids: string): DocsView
  setMode(mode: string): DocsView
  setEnableDrives(b: boolean): DocsView
  setOwnedByMe?(b: boolean): DocsView
}
interface PickerBuilder {
  addView(v: DocsView): PickerBuilder
  enableFeature(f: string): PickerBuilder
  setOAuthToken(t: string): PickerBuilder
  setDeveloperKey(k: string): PickerBuilder
  setAppId(id: string): PickerBuilder
  setTitle(t: string): PickerBuilder
  setOrigin(o: string): PickerBuilder
  setCallback(cb: (data: PickerResponse) => void): PickerBuilder
  build(): { setVisible(v: boolean): void; dispose?(): void }
}
interface PickerResponse {
  action: string
  docs?: { id: string; name: string; mimeType: string; parentId?: string }[]
}

const GAPI_SRC = 'https://apis.google.com/js/api.js'
const FOLDER_MIME = 'application/vnd.google-apps.folder'

export class GooglePicker implements DrivePicker {
  private readonly config: DriveConfig
  private ns: Promise<PickerNs> | null = null

  constructor(config: DriveConfig) {
    this.config = config
  }

  /** Load gapi + the picker module (idempotent). */
  preload(): Promise<PickerNs> {
    this.ns ??= loadScript(GAPI_SRC)
      .then(
        () =>
          new Promise<PickerNs>((resolve, reject) => {
            const gapi = (globalThis as unknown as { gapi?: { load(name: string, cb: { callback: () => void; onerror: () => void }): void } }).gapi
            if (!gapi) return reject(new Error('gapi missing'))
            gapi.load('picker', {
              callback: () => resolve((globalThis as unknown as { google: { picker: PickerNs } }).google.picker),
              onerror: () => reject(new Error('picker failed to load')),
            })
          }),
      )
      .catch((e) => {
        this.ns = null
        throw new DriveError('network', `Could not load the Google Drive picker: ${(e as Error).message}`)
      })
    return this.ns
  }

  async pickFolder(token: string, opts: { title: string }): Promise<PickedItem | null> {
    const p = await this.preload()
    const view = new p.DocsView(p.ViewId.FOLDERS).setIncludeFolders(true).setSelectFolderEnabled(true).setMimeTypes(FOLDER_MIME).setEnableDrives(true)
    const picked = await this.show(p, token, opts.title, view, false)
    return picked[0] ?? null
  }

  async pickFiles(token: string, opts: PickFilesOptions): Promise<PickedItem[]> {
    const p = await this.preload()
    const view = new p.DocsView(p.ViewId.DOCS).setIncludeFolders(true).setSelectFolderEnabled(opts.allowFolders ?? false).setMode(p.DocsViewMode.GRID)
    if (opts.mimeTypes?.length) view.setMimeTypes(opts.mimeTypes.join(','))
    if (opts.fileIds?.length) view.setFileIds(opts.fileIds.join(','))
    else if (opts.parentId) view.setParent(opts.parentId)
    else view.setEnableDrives(true)
    return this.show(p, token, opts.title, view, opts.multiselect ?? false)
  }

  private show(p: PickerNs, token: string, title: string, view: DocsView, multiselect: boolean): Promise<PickedItem[]> {
    return new Promise((resolve) => {
      let builder = new p.PickerBuilder()
        .addView(view)
        .setOAuthToken(token)
        .setDeveloperKey(this.config.apiKey)
        .setAppId(this.config.appId)
        .setTitle(title)
        .enableFeature(p.Feature.SUPPORT_DRIVES)
        .setCallback((data) => {
          if (data.action === p.Action.PICKED) {
            resolve((data.docs ?? []).map((d) => ({ id: d.id, name: d.name, mimeType: d.mimeType, parentId: d.parentId })))
          } else if (data.action === p.Action.CANCEL) {
            resolve([])
          }
        })
      if (multiselect) builder = builder.enableFeature(p.Feature.MULTISELECT_ENABLED)
      if (typeof window !== 'undefined') builder = builder.setOrigin(window.location.origin)
      builder.build().setVisible(true)
    })
  }
}
