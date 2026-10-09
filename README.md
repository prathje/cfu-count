# CFU Count

A browser-only bacterial colony counter. Load plate photos, tap colonies to mark
them in named annotation groups, and export per-image counts. Projects are saved in
the browser (IndexedDB) and can be linked to a Google Drive folder, which then
holds the project files (`project.json`, `annotations/*.json`, `summary.csv`).
An optional "Find similar" step suggests colonies like the ones you marked; you
review the suggestions before any of them are counted.

There is no server. Images never leave the browser except when you save them to
your own Google Drive.

Live: <https://prathje.github.io/cfu-count/>

## Development

Requires Node 22 (CI uses 22). The eval harness runs TypeScript directly with
Node's built-in type stripping (on by default from Node 22.18); it was developed on
Node 26.

```bash
npm install
npm run dev        # dev server at http://localhost:5173
npm test           # unit tests (vitest)
npm run typecheck  # tsc -b
npm run build      # typecheck + production build into dist/
npm run eval -- --images <dir> --seeds scripts/eval/agent-seeds.json
                   # node-only detector evaluation, writes .eval-out/
```

`?demoStorage` in the URL uses an in-memory demo project instead of IndexedDB.
`/viewport-demo.html` is a standalone viewport test page.

## Google Drive

Drive is optional; without configuration the app works locally. To enable it, create
a Google Cloud OAuth web client and a Picker API key and put them in `.env.local`
(see [docs/google-drive-setup.md](docs/google-drive-setup.md)). The values are
public identifiers compiled into the bundle; GitHub Pages builds read them from
repository variables. Access tokens are kept in memory only.

Pushing to `main` deploys to GitHub Pages (`.github/workflows/deploy.yml`).

## Layout

| Path | Contents |
| --- | --- |
| `src/model` | Data contract (schema v1) and pure domain rules |
| `src/storage` | IndexedDB working copy, zip/CSV codecs, Google Drive sync |
| `src/state` | Editor store (slices, undo, autosave); `assist/` for Find similar |
| `src/detection` | Pure-TS colony detector and its Web Worker |
| `src/viewport` | Canvas viewport: rendering, gestures, display adjustments |
| `src/ui` | SolidJS components and containers |
| `src/demo` | In-memory demo repository |
| `scripts/eval` | Node harness to evaluate the detector on local plates |

## Documentation

- [docs/architecture.md](docs/architecture.md): modules, seams, data flow
- [docs/schema.md](docs/schema.md): project, annotation and CSV formats
- [docs/google-drive-setup.md](docs/google-drive-setup.md): Google Cloud configuration
- [docs/test-report.md](docs/test-report.md): what is verified, what is not, manual checklists
- [docs/research/input-interactions.md](docs/research/input-interactions.md): pointer, pen and touch handling
- [docs/research/google-drive.md](docs/research/google-drive.md): Drive access model and sync design
- [docs/research/automated-counting.md](docs/research/automated-counting.md): detection approaches
- [docs/research/detection-results.md](docs/research/detection-results.md): detector results on test plates
- [colony-counter-build-brief.md](colony-counter-build-brief.md): product brief and acceptance criteria
