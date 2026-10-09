# Data schema v1

The TypeScript source of truth is `src/model/types.ts`. Runtime validation of files
read from Drive or a `.zip` lives in `src/storage/validate.ts`. JSON is the record;
`summary.csv` is derived from it and is never read back.

## Layout

A Drive project folder and an exported `.zip` share one layout:

```
project.json                 project, image list, groups (+ Drive file-ID hints in a Drive folder)
summary.csv                  derived per-image × per-group counts
annotations/<imageId>.json   one annotation document per image
images/…                     Drive: local images uploaded by the app (original file name)
                             zip:   images/<imageId>.<ext>
```

Images picked from elsewhere in Drive stay where they are: `ImageRecord.source.fileId` is
their identity, never the file name.

## Conventions

- `schemaVersion` is `1` in `project.json` and in every annotation document. Files with a
  higher version are rejected with "written by a newer version of the app".
- IDs are opaque strings (UUID v4 for app-generated IDs). Names are display labels only.
- Timestamps are ISO-8601 UTC strings.
- **Coordinates** are original-image pixels of the image *after* EXIF orientation
  (`ImageRecord.width × height`). `(0,0)` is the top-left corner of the top-left pixel;
  pixel centres are at `+0.5`.
- `AnnotationGroup.labelSize` is the label font size in CSS pixels (screen space);
  readers default it to `12` when missing.
- `AnnotationGroup.size` is a display radius in CSS pixels (screen space). It is not a
  measured colony size; a fitted colony radius is in `Annotation.geometry.r`
  (image pixels).
- Extra unknown fields are preserved when reading; required fields must be present.
- Readers repair what can be repaired instead of rejecting the file: an image whose
  `imageGroupId` names no existing image group becomes ungrouped (`null`, with a
  warning shown on open); a manual annotation whose `reviewStatus` is not `accepted`
  is read as `accepted` (manual marks are always confirmed).

## project.json

| Field | Type | Notes |
| --- | --- | --- |
| `schemaVersion` | `1` | |
| `id` | string | stable project ID |
| `name` | string | |
| `createdAt`, `updatedAt` | timestamp | |
| `imageGroups` | `{id, name}[]` | user-defined image groups (Treatment A, Batch 2, …) |
| `images` | ImageRecord[] | see below |
| `annotationGroups` | AnnotationGroup[] | project-wide marker groups, in display order |
| `storage` | `{kind:"local"}` or Drive link | see below |
| `revision` | number | incremented on every local save |

`storage`, `revision` and each image's `source` / `sourceMismatch` are
*storage-owned*: the editor never changes them, and the app
merges them with `applyStorageOwned` (src/model/project.ts) when storage reports a
change.

ImageRecord:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | stable image ID; names its annotation document |
| `name` | string | display label |
| `imageGroupId` | string \| null | |
| `width`, `height` | number | oriented pixel size; coordinates refer to these |
| `mimeType` | string | detected from the file's bytes, not its extension |
| `byteSize` | number | |
| `fingerprint` | string | SHA-256 hex of the original bytes |
| `source` | `{kind:"local"}` or `{kind:"drive", fileId, version?, md5Checksum?}` | `md5Checksum` is recorded at import so a replaced Drive file can be detected |
| `addedAt` | timestamp | |
| `sampleId` | string? | reserved for multi-channel photos of one plate (unused in v1) |
| `sourceMismatch` | object? | set by storage when the source bytes changed after annotation: `{detectedAt, message, remoteMd5?, remoteWidth?, remoteHeight?}` |
| `display` | ImageDisplayAdjust? | display-only view setting (editor-owned); absent = unadjusted. See below |
| `deletedAt` | timestamp? | set when the user removed the image from the project (soft delete, editor-owned); absent = part of the project. See below |

**Removed images (soft delete).** Removing an image only sets `deletedAt`. Nothing is
erased: the record stays in `project.json`, its annotation document stays in
`annotations/`, its bytes stay in the browser, the `.zip` export and the Drive folder,
and a Drive file is never deleted. A removed image is left out of the image list,
next/previous navigation, project image counts, `summary.csv` (no rows) and the
reference plates offered by Find similar. Because its record still references its
Drive file, a folder scan never imports that file again (picking it in the Drive
Picker says to restore it instead). "Recently removed" in the sidebar lists removed
images; Restore deletes the field. Archive export/import and Drive save/open keep
the field. (Older files may contain `excludedDriveFileIds` from before soft delete;
readers drop it.)

ImageDisplayAdjust (`src/model/display.ts`) changes only how the viewport shows the
image layer. It never changes image bytes, annotation coordinates, counts, markers
or detector input. Readers are lenient: a missing or invalid field takes its default,
numbers are clamped, and an all-default value is dropped (never a load error).

| Field | Type | Default | Range / meaning |
| --- | --- | --- | --- |
| `brightness` | number | 0 | −1…1; adds `brightness/2` to the 0…1 value |
| `contrast` | number | 0 | −1…1; slope `2^(2·contrast)` around mid-grey |
| `gamma` | number | 1 | 0.2…5; output `v^(1/gamma)` (> 1 lightens midtones) |
| `saturation` | number | 1 | 0…3; colour view only (0 = grey) |
| `invert` | boolean | false | swap light and dark |
| `channel` | `"rgb" \| "red" \| "green" \| "blue" \| "luma"` | `"rgb"` | single channels and `luma` (Rec. 709) are shown as grey |
| `autoContrast` | boolean | false | stretch the 0.5 %–99.5 % percentiles of the displayed values (histogram of the smallest pyramid level) to full range |

Order: channel matrix (channel view, saturation) → auto-contrast stretch →
brightness → contrast → clamp → gamma → invert. Changing it saves `project.json`
only.

Drive link (`storage.kind = "drive"`):

| Field | Notes |
| --- | --- |
| `folderId`, `folderName` | the project folder |
| `files` | written to Drive only, as hints: `{projectJson?, summaryCsv?, annotationsFolder?, imagesFolder?, annotations: {imageId → fileId}}`. Lets another user on the narrow `drive.file` scope request access to files they cannot list yet. Not part of the app's data model; readers may ignore it |
| `account` | local only: never written to Drive or exported |

Sync bookkeeping is not part of the model. Each browser keeps the output file IDs
and the Drive `md5Checksum` it last read or wrote for each of them (used for
conflict checks) in its local sync state (`SyncState.drive` in
`src/storage/localStore.ts`), never in `project.json`.

Example:

```json
{
  "schemaVersion": 1,
  "id": "6f1c2a9e-0b7d-4d0e-9a51-0c3e8f0a7b21",
  "name": "E. coli dilution series",
  "createdAt": "2026-10-01T09:12:00.000Z",
  "updatedAt": "2026-10-02T14:30:05.120Z",
  "imageGroups": [{ "id": "b3e1…", "name": "Dilution 10^-4" }],
  "images": [
    {
      "id": "0d9a7c3e-5f0b-4c8e-a1d2-3e4f5a6b7c8d",
      "name": "plate-03.jpg",
      "imageGroupId": "b3e1…",
      "width": 3024,
      "height": 4032,
      "mimeType": "image/jpeg",
      "byteSize": 2845123,
      "fingerprint": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "source": { "kind": "drive", "fileId": "1AbCdEfGhIjKlMnOp", "version": "3", "md5Checksum": "5d41402abc4b2a76b9719d911017c592" },
      "addedAt": "2026-10-01T09:15:42.000Z"
    }
  ],
  "annotationGroups": [
    { "id": "g-main", "name": "Main colonies", "color": "#e5484d", "render": "dot", "opacity": 0.85, "size": 6, "labels": false, "labelSize": 12, "hidden": false, "locked": false },
    { "id": "g-small", "name": "Small colonies", "color": "#3e63dd", "render": "circle", "opacity": 1, "size": 5, "labels": true, "labelSize": 12, "hidden": true, "locked": true }
  ],
  "storage": {
    "kind": "drive",
    "folderId": "1FoLdEr",
    "folderName": "E. coli dilution series",
    "files": {
      "projectJson": "1PrOjEcT",
      "summaryCsv": "1SuMmArY",
      "annotationsFolder": "1AnNoTs",
      "imagesFolder": "1ImAgEs",
      "annotations": { "0d9a7c3e-5f0b-4c8e-a1d2-3e4f5a6b7c8d": "1AnNoTaTiOnDoC" }
    }
  },
  "revision": 42
}
```

## annotations/&lt;imageId&gt;.json

| Field | Type | Notes |
| --- | --- | --- |
| `schemaVersion` | `1` | |
| `projectId`, `imageId` | string | |
| `imageFingerprint`, `width`, `height` | | the image these coordinates were made against |
| `groups` | AnnotationGroup[] | snapshot of the project's groups, so the file stands alone (see below) |
| `annotations` | Annotation[] | |
| `detectionRuns` | DetectionRun[] | required; `[]` when no detection run was reviewed |
| `updatedAt` | timestamp | |

**Group snapshots.** `project.json` is the source of truth for annotation groups
(names, colours, visibility, lock, order). A document's `groups` snapshot is
refreshed only when that document is saved for its own reasons (an annotation on
that image changed) and whenever the project is exported as a `.zip`. Changing a
group's visibility, lock, style or order therefore rewrites `project.json` only and
never re-uploads every annotation document (which would also cause spurious Drive
conflicts). Readers resolve groups from `project.json` first and use a document's
snapshot only for groups the project no longer has.

Annotation:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | |
| `x`, `y` | number | image coordinates (see Conventions) |
| `groupId` | string | |
| `origin` | `"manual"` \| `"automated"` | immutable; never inferred from tool, group or colour |
| `createdAt`, `updatedAt` | timestamp | |
| `reviewStatus` | `"unreviewed"` \| `"accepted"` \| `"rejected"` | manual marks are always `accepted` (enforced on read) |
| `reviewedAt` | timestamp? | |
| `lastEditSource` | `"manual"` \| `"automated"` | |
| `manuallyAdjusted` | boolean | a person moved or changed an automated mark |
| `detector` | `{name, version, runId, params?, confidence}`? | automated only; `confidence: null` = the method has no meaningful score; `runId` refers to `detectionRuns` |
| `geometry` | `{kind:"circle", r, quality?, source:"fit"\|"seed-estimate"}`? | inferred colony extent in image pixels; never changes origin or review fields |

DetectionRun (one reviewed automated run; pending, undecided suggestions are never
stored). There are two kinds:

- **Accept run.** Written with an accept, as part of the same undo step. The accepted
  annotations refer to it through `detector.runId`; `negatives` are the suggestions
  rejected in the accepted scope. Undo removes it, redo restores it (only while the
  image bytes still match `imageFingerprint`).
- **Reject-only run.** Rejections the user made without an accept that records them
  (for example "Reject all") are kept in one run per review with `negatives` and zero
  accepted annotations (`diagnostics.accepted = 0`, `diagnostics.acceptScope =
  "reject"`); no annotation refers to it. It follows the review while the panel's
  suggestions exist: restoring a rejection removes it from `negatives` (the run is
  removed when none are left). It is not an undo step, because it changes no
  annotation or count.

Negatives are audit and training data only. They never suppress suggestions: a
later run may suggest the same spots again, and the user can accept them then.

Runs are an audit trail. Deleting an annotation group keeps the runs that targeted
it, so `targetGroupId` may name a group that no longer exists; readers must accept
that (validation checks only that it is a string).

| Field | Type | Notes |
| --- | --- | --- |
| `runId`, `method`, `version`, `createdAt` | string | |
| `imageFingerprint` | string | must equal the document's `imageFingerprint` |
| `seedImageFingerprints` | `{imageId: sha256}`? | for seeds taken from other plates |
| `analysisScale` | number | analysis resolution relative to the original, e.g. `0.5` |
| `targetGroupId` | string | may name a deleted group (see above) |
| `roi` | `{kind:"circle",cx,cy,r}` \| `{kind:"rect",x,y,w,h}`? | image coordinates; absent = whole image |
| `seeds` | `{annotationId, imageId, x, y, radiusPx (number\|null), quality}[]` | `quality`: `ok`, `touching`, `edge`, `glare`, `weak`; coordinates copied for reproducibility |
| `prior`, `settings` | object | method-specific |
| `negatives` | `{x, y}[]`? | rejected suggestions kept as negative examples (never a filter) |
| `diagnostics` | object? | |

Example:

```json
{
  "schemaVersion": 1,
  "projectId": "6f1c2a9e-0b7d-4d0e-9a51-0c3e8f0a7b21",
  "imageId": "0d9a7c3e-5f0b-4c8e-a1d2-3e4f5a6b7c8d",
  "imageFingerprint": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "width": 3024,
  "height": 4032,
  "groups": [
    { "id": "g-main", "name": "Main colonies", "color": "#e5484d", "render": "dot", "opacity": 0.85, "size": 6, "labels": false, "labelSize": 12, "hidden": false, "locked": false }
  ],
  "annotations": [
    {
      "id": "a-001", "x": 1520.5, "y": 2011.5, "groupId": "g-main",
      "origin": "manual", "createdAt": "2026-10-01T10:00:00.000Z", "updatedAt": "2026-10-01T10:00:00.000Z",
      "reviewStatus": "accepted", "lastEditSource": "manual", "manuallyAdjusted": false
    },
    {
      "id": "a-002", "x": 1601.25, "y": 1988.0, "groupId": "g-main",
      "origin": "automated", "createdAt": "2026-10-02T11:00:00.000Z", "updatedAt": "2026-10-02T11:05:00.000Z",
      "reviewStatus": "accepted", "reviewedAt": "2026-10-02T11:05:00.000Z",
      "lastEditSource": "manual", "manuallyAdjusted": true,
      "detector": { "name": "seeded-blob", "version": "0.1.0", "runId": "run-7", "confidence": null },
      "geometry": { "kind": "circle", "r": 11.5, "quality": 0.82, "source": "fit" }
    }
  ],
  "detectionRuns": [
    {
      "runId": "run-7", "method": "seeded-blob", "version": "0.1.0", "createdAt": "2026-10-02T11:00:00.000Z",
      "imageFingerprint": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "analysisScale": 0.5, "targetGroupId": "g-main",
      "roi": { "kind": "circle", "cx": 1512, "cy": 2016, "r": 1400 },
      "seeds": [{ "annotationId": "a-001", "imageId": "0d9a7c3e-5f0b-4c8e-a1d2-3e4f5a6b7c8d", "x": 1520.5, "y": 2011.5, "radiusPx": 12, "quality": "ok" }],
      "prior": { "logRadiusMu": 2.4, "logRadiusSigma": 0.3 },
      "settings": { "sensitivity": 0.6 }
    }
  ],
  "updatedAt": "2026-10-02T11:05:00.000Z"
}
```

## summary.csv

UTF-8 with a byte-order mark (so Excel detects the encoding), CRLF line endings,
RFC 4180 quoting. Any text cell that starts with `=`, `+`, `-`, `@`, TAB or CR gets a
leading `'` so spreadsheets show it as text instead of running it as a formula.

**One row per image × annotation group**, zero-count groups included. Removed
images (`deletedAt` set) get no rows. Groups that
appear in an image's annotations but no longer exist in the project get their own rows,
so no annotation is silently dropped. There is no per-image total column; sum
`confirmed_count` over an image's rows to get it, which avoids double-counting.

| Column | Meaning |
| --- | --- |
| `project_id`, `project_name` | |
| `image_group_id`, `image_group_name` | empty if the image has no group |
| `image_id`, `image_name` | |
| `drive_file_id` | source image's Drive file ID (empty for local-only images) |
| `annotation_group_id`, `annotation_group_name` | |
| `confirmed_count` | `manual_count + automated_accepted_count`; the same count the app shows (`isConfirmed` in src/model/annotations.ts) |
| `manual_count` | annotations with `origin = manual` (manual marks are always `accepted`, so always confirmed) |
| `automated_accepted_count` | `origin = automated` and `reviewStatus = accepted` |
| `automated_unreviewed_count` | stored annotations with `origin = automated` and `reviewStatus = unreviewed`; **not** in `confirmed_count`. Pending Find-similar suggestions are never stored, so projects made with this app have 0 here unless another tool wrote such marks |
| `group_hidden`, `group_locked` | `true`/`false`; metadata only, never changes counts |
| `image_width`, `image_height` | oriented pixel size |
| `image_fingerprint_sha256` | |
| `annotations_updated_at` | `updatedAt` of the annotation document (empty if none) |

Automated annotations with `reviewStatus = rejected` are not counted in any column.
`origin` never changes when an automated mark is accepted, moved or regrouped, so the
CSV and the JSON agree on manual versus automated counts.
