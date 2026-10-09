# Google Drive access from a static site: research notes

Researched 2026-10-09 against Google's official documentation. These notes back the
design in `src/storage/drive/` and the setup guide in `docs/google-drive-setup.md`.

## Questions

1. What does the `drive.file` scope actually grant?
2. Does picking a folder in Google Picker grant access to the files already in it?
3. What is the least-privilege way to treat "the whole Drive folder as the project"?
4. What do the broader scopes cost (verification, security assessment)?
5. What does the browser token model require (expiry, popups, storage)?
6. What concurrency guarantees does Drive offer for safe updates?

## Findings

### 1. `drive.file` semantics

The scope table describes `drive.file` as: "Create new Drive files, or modify existing
files, that you open with an app or that the user shares with an app while using the
Google Picker API or the app's file picker." Google classifies it as **non-sensitive**
and recommends it. Access is **per file**, which means:

- files the app created are always accessible to the user who created them;
- existing files become accessible when the user picks them in Google Picker
  (the Picker must be built with `setAppId(<cloud project number>)` for the grant to
  apply to this app);
- folder listing (`'<id>' in parents`) only returns children the app already has
  access to.

Sources: [Choose Google Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth),
[Integrate the Google Picker into web apps](https://developers.google.com/workspace/drive/picker/guides/web-picker).

### 2. Picking a folder does not grant its contents

Google's scope and Picker docs do not say that a folder grant covers its children. The
only statement from Google I found is from a Google developer-relations engineer (Eric
Koleda) in the Apps Script community group (2019): "the drive.file scope doesn't give
you access to files within a folder that was picked." Third-party write-ups say the
same and recommend testing it yourself. No newer official statement contradicts it.

What a folder pick *does* give: the app can read the folder's metadata, list the
children it already has access to, and create new files inside the folder.

**Status: not yet verified with a real account.** The design assumes the conservative
reading, and the first manual test (see the checklist in the storage hand-off) checks it.

Sources: [Google Groups thread](https://groups.google.com/g/google-apps-script-community/c/_W-NKbttfbo/m/DieCBbNHBQAJ),
[DocsView reference](https://developers.google.com/workspace/drive/picker/reference/picker.docsview).

### 3. Least-privilege design for "folder = project"

Picker features that make the per-file model usable:

- `DocsView.setParent(folderId)` opens the picker inside a known folder, with
  `MULTISELECT_ENABLED` so the user can select every image in one go.
- `DocsView.setFileIds("id1,id2,…")` (rolled out January 2025) shows the picker
  pre-filtered to known file IDs, built so apps can request `drive.file` access to
  specific files quickly. It cannot be combined with `setParent`/`setEnableDrives`,
  and it hides files the user cannot access.
  [Workspace Updates, Nov 2024](https://workspaceupdates.googleblog.com/2024/11/new-file-picker-method-for-pre-selecting-google-drive-files.html),
  [setFileIds reference](https://developers.google.com/workspace/drive/picker/reference/picker.docsview.setfileids)
- `setSelectFolderEnabled(true)` with the `FOLDERS` view lets the user pick a folder.

The resulting flow (implemented in `repository.ts` → `openProjectFromDrive`):

1. The user picks the project **folder**. The app can now list what it has access to
   and create files in that folder.
2. If `project.json` is visible (the same user saved it from this app, on any device),
   it is read directly, along with `annotations/` and `images/`.
3. If nothing is visible (a new folder of photos, or a folder another person shared),
   one Picker opens inside the folder (`setParent`) asking the user to select
   `project.json`, if there is one, and the images. One multi-select step.
4. Once `project.json` is readable it lists every referenced file ID (annotation docs,
   images, subfolders, summary.csv). Any of them the app still cannot read go into a
   single Picker built with `setFileIds(...)`: "select all, then Select".
5. Images the user adds later through "Add images from Drive" open the Picker inside
   the project folder (`setParent`).

Files the app creates (outputs, and local images uploaded to `images/`) stay
accessible to that user without further prompts, so reopening one's own project on
another device needs only the folder pick.

Whether files created by this app on user A's account are readable by user B via the
same app without B picking them is **not stated in the docs**. The design does not
depend on it: anything B cannot read appears in step 4. **Verify with two accounts.**

### 4. Broader scopes: cost

| Scope | Class | What it adds | Cost |
| --- | --- | --- | --- |
| `drive.file` | non-sensitive | per-file access as above | basic/brand verification only when published |
| `drive.readonly` | **restricted** | read every file; folder listings show all images | restricted-scope verification |
| `drive` | **restricted** | full read/write of all Drive files | restricted-scope verification |

Restricted scopes are only allowed for certain app categories (backup/sync,
productivity/education, reporting/security). Per the verification page, "every app
that requests access to Google users' restricted data and has the ability to access
data from or through a third-party server must go through a security assessment."
This app sends nothing to its own server, which is an argument for not needing a
security assessment, but Google makes that call during verification. Verification is
not needed for personal use, for apps that stay in Testing (user cap and warning screen
apply), or for Internal apps in a Workspace organisation.

Sources: [About auth (Drive)](https://developers.google.com/workspace/drive/api/guides/about-auth),
[Restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).

**Decision:** default to `drive.file`. A build can opt in with
`VITE_GOOGLE_DRIVE_SCOPE=readonly`, which requests `drive.file drive.readonly` (read
everything, write only the app's own outputs), or `full` (`drive`). With a broader
scope the same code finds folder images automatically, because `pullFolder` treats
every visible image in the folder root and `images/` as part of the project; the
grant Picker steps are then simply never needed. Choose this for a lab-internal
deployment (Workspace "Internal" app, or Testing with named users) where
verification does not apply.

### 5. Token model (Google Identity Services)

- `google.accounts.oauth2.initTokenClient({client_id, scope, callback, error_callback})`
  then `requestAccessToken()` must be called from a user gesture; it opens a popup.
- Overrides: `prompt` (`''` = only prompt when needed), `login_hint` (skips the
  account chooser on reconnect).
- The response contains `access_token`, `expires_in` (normally 3600 s) and `scope`.
  With granular consent the user can untick scopes, so check `hasGrantedAllScopes`.
- "In the Token model, an access token is not stored by the OS or browser."
  Renewal = call `requestAccessToken()` again from a user action. No refresh token
  and no client secret in this flow.
- `google.accounts.oauth2.revoke(token)` withdraws consent.

Implementation consequences: the GIS script is preloaded when the app starts, so the
popup opens synchronously inside the click (Safari blocks popups opened after an
`await`). The token lives only in `DriveSession` memory. An expiry timer (60 s early)
and any HTTP 401 switch DriveState to `expired`, and the save status to
`reconnect-required` while changes are pending.

Source: [Using the token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model).

### 6. Concurrency and safe updates

- File resource fields ([reference](https://developers.google.com/workspace/drive/api/reference/rest/v3/files)):
  `version` is "a monotonically increasing version number … reflects every change made
  to the file on the server, even those not visible to the user", including metadata
  changes; `md5Checksum` covers the content of binary files; `headRevisionId` is the
  current content revision.
- Drive v3 has no compare-and-swap on update (no conditional `If-Match` in the v3
  documentation), and no multi-file transactions.

Decision: conflict detection compares **`md5Checksum`** (content) with the value this
browser last read or wrote. `version` would also flag renames and sharing changes as
conflicts. Every push checks all target files *before* writing any, writes
`project.json` last as a commit marker, and records each created file ID locally as it
goes so a retry updates files instead of duplicating them. A short race window between
check and write remains and is documented, not hidden.

### Upload mechanics

- Files up to 5 MB: `POST /upload/drive/v3/files?uploadType=multipart`.
- Larger (phone photos): `uploadType=resumable`, one session, a single `PUT` of the body.
- Content updates: `PATCH /upload/drive/v3/files/{id}?uploadType=media` (or `multipart`
  when `appProperties` change too), keeping the file ID.
- `supportsAllDrives=true` everywhere; listings use `includeItemsFromAllDrives=true` and
  `corpora=allDrives` so shared-drive folders work.
- Picker API key: if restricted to websites, also allow `https://docs.google.com/*`,
  because the Picker runs in an iframe on that domain.

## Open items to verify with a real Google account

1. Picking a folder grants no access to existing children (expected: their files do
   not appear in listings until picked).
2. Files created by this app for user A, in a folder shared with user B: are they
   readable by B without picking? (The code handles both outcomes.)
3. `setFileIds` with folder IDs plus `setSelectFolderEnabled(true)` lets the user
   select the `annotations/` and `images/` subfolders in the grant step.
4. A resumable upload's `Location` header is readable from the browser (CORS) on the
   GitHub Pages origin.
5. Safari (macOS and iPadOS): the consent popup opens from the Connect button, and the
   Picker iframe works with the restricted API key.
