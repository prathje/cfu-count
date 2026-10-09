# Colony detection: Phase 0 + 1a + 1b results

Status: 2026-10-09. The detectors are implemented in `src/detection/` and the evaluation harness in `scripts/eval/`. Nothing is wired into the UI yet. **There is no ground truth yet.** Every number below is a count, a runtime or an agreement between methods, never an accuracy. Seeds were picked by an AI agent, not by a microbiologist (see §3).

Read with: `docs/research/automated-counting.md` (options and the adopted plan) and `colony-fitting-method-brief.md` (the mainline method).

## 1. What the test photos look like

21 JPEGs in `test_images/` (the task said 22; the folder holds 21). All are Nikon D750, 6016×4016, EXIF orientation 1, about 6.5 MB each. Findings that changed the plan:

| Observation | Consequence |
| --- | --- |
| **Square plates with rounded corners** (about 120 mm), not round dishes. The plate sits in a dark gap between two blocks of white foam. | The circle-Hough ROI in the plan would fail. The auto-ROI grows the agar region from the image centre, takes the convex hull and erodes it by an adaptive rim band (§2.3). Hough is still implemented and tested for round dishes, but the ROI does not use it. |
| Agar is dark grey (luma about 70). Colonies are **brighter** than the agar: cream/yellow (1268–1291), grey-green and soft-edged (1249, 1250). | Polarity and colour axis come from the seeds (Lab projection), so dark colonies on light agar work too. They are not in this set. |
| **6 fluorescence photos** (1292–1297) through a green filter. The foam saturates green, the plate wall glows and colonies are bright green on dark green. | The contrast axis comes out mostly as +L/−a. The glowing wall forced the adaptive rim margin. |
| Typical colony radius is about 20–30 px in the original (19–29 px from seed calibration). 1249/1250 have larger, hazy colonies (45–56 px). | At 2048 px long side, r ≈ 7–10 px. Touching colonies are separated by 1–2 px seams, which are lost below r ≈ 8 px (§2.6). |
| Layout: two **dense streaks** per plate (50–150 colonies each, heavily merged on 1249/1250/1292–1297), plus a few dozen isolated or touching colonies. | Most of the count is in clusters. Per-cluster ambiguity is the main problem, as the brief expected. |
| **Bubbles** (dark centre, bright ring: 1268, 1284, 1290, 1291), ring-light highlights on colony rims (small orange specks), writing on the lid (bottom right), condensation drops at the rim (1291). | The appearance term penalises ring-like disks. Writing and rim drops fall in the excluded rim band or are too dark to pass the polarity-aware threshold. |
| 4 near-empty plates (1281 has 1 colony; 1283–1285 have none, only bubbles and dust). | Good false-positive tests. Run with seeds from another plate (cross-plate calibration). |
| Mild vignetting: interior luma varies ±12–17 % across the plate. | Background flattening is needed (masked Gaussian per Lab channel), and the rim test must be relative (§2.3). |

## 2. Implementation

### 2.1 Modules (`src/detection/`)

| Module | Role |
| --- | --- |
| `image/` | Pure-TS primitives on typed arrays: `color` (sRGB→Lab, luma), `filters` (separable Gaussian, 3-box large-σ Gaussian, box, masked/normalised Gaussian, median, gradients, area resize), `morphology` (van Herk min/max, opening/closing, top-hats), `threshold` (Otsu with plateau midpoint, adaptive mean, robust statistics), `components` (two-pass union-find labelling, hole fill), `distance` (Felzenszwalb EDT), `blobs` (scale-normalised LoG, local maxima, circle NMS), `contour` (boundary, Moore tracing, concave points, arc split, Kåsa and Gauss–Newton circle fits), `hough` (gradient Hough and RANSAC circle), `watershed` (priority flood), `geometry` (hull, polygon raster, simplification). 32 unit tests on synthetic input. |
| `roi.ts` | Auto plate ROI plus user circle/rect override (§2.3). |
| `features.ts` | Lab planes, masked background, contrast plane `F`, noise σ. |
| `calibrate.ts` | Seed radius from sector profiles, quality flags, log-normal prior, appearance ranges. |
| `methods/watershed.ts` | Baseline **W**. |
| `methods/log.ts` | Detector **A** (also a candidate source for H). |
| `methods/fitter.ts` | Mainline **H**, the union-of-circles fitter. |
| `detect.ts` | Pipeline, `detect()`, `calibrate()`, `DetectorCache`, run record. |
| `scale.ts` | `chooseAnalysisScale()`. |
| `accept.ts` | `suggestionsToAnnotations()`: accepted suggestions become `Annotation`s. |
| `protocol.ts`, `worker-core.ts`, `worker.ts`, `client.ts` | Module Worker and the typed client (§2.7). |

The whole module bundles to about 22 KB gzip. The worker chunk is 51 KB raw (checked with a throwaway Vite lib build). No runtime dependency was added. `sharp` is a devDependency used only in `scripts/eval/`.

### 2.2 Pipeline

1. **Prepare**: RGBA at analysis scale → Lab, saturation mask, ROI. Cached per image, scale and ROI.
2. **Contrast axis**: for each seed, Lab at the click minus a first-pass background (masked Gaussian, σ = 5 % of the plate diameter, over the plate). The axis is the per-component median of these differences, normalised. Contrast plane `F = (Lab − background) · axis`, so agar ≈ 0 and colonies are positive.
3. **Seed measurement** on `F` (§2.4). This gives a first prior.
4. **Second background pass**: exclude `F > max(3σ, 0.25·contrast)` dilated by 1.5·r̃, with σ_bg = max(4·r_hi, 4 % of the plate). Recompute `F` and re-measure the seeds. Without the exclusion, the gaps inside dense streaks lifted the background and made streak colonies look dim.
5. **Method** (W, A or H) on `F`, with foreground mask `Fs > max(k·σ, f·contrast)`. `Fs` is `F` smoothed by σ = 0.15·r̃. Defaults f = 0.475, k = 3; both are controlled by `sensitivity`. Holes < 0.15·A0 are filled and specks < 0.3·π·r_lo² removed.
6. **Post-filter**: keep suggestions whose centre is inside the ROI and not within 0.5·max(r) of any existing annotation (any group). Results are in original px.

### 2.3 Plate ROI

On a ≤ 480 px luma image: take the median agar luma in the central 30 % window; keep pixels in [0.55, 1.5] × agar; open by about 0.6 % of the size; keep the component covering the centre; fill holes; trace the outline; take the convex hull. The hull is needed because colonies touching the wall notch the region. **Rim band**: for each distance d from the outline, compute the 90th percentile of |luma − agar|/agar over the ring at d. Rings within 8 % of the diameter that exceed the interior rings' level by 0.12 are rim. The margin is max(2.5 % × equivalent diameter, rim + 1 %). In the end this excluded 98–199 original px (2.7–5.4 % of the plate width). A fixed 15 % threshold had failed because vignetting alone makes interior rings deviate 12–17 %. If the plate is not found, the ROI falls back to the central 90 % with a warning. ROI shape (`round`/`square`/`other`) is reported, and all 21 photos came out `square`.

Known imperfection: on 1293 the hull leaks into the foam shadow at the bottom-left corner. The rim band covers it.

### 2.4 Seed calibration (S)

- **Radius from a point**: 24 sectors, each sampled with 3 rays every 0.5 px out to r_max = 6 % of the plate diameter. Per sector, the boundary is the first crossing of the half level between the peak (max of centre and inner ring) and a baseline (the tail median, capped at 0.25·peak). A sector that never falls is *blocked* (merged). One that falls and rises again within 2.2·r is a *touching neighbour*. A Kåsa circle through the clean boundary points re-centres the estimate up to twice; the shift is capped at 0.6·r so it cannot walk to a neighbour. The annotation itself is never moved. The steepest radial descent (`rEdge`) is a cross-check on the radius.
- **Quality flags**, in precedence order: `edge` (clearance to the ROI edge < 1 px) > `glare` (> 25 % saturated, or centre darker than its ring) > `touching` (≥ 30 % of sectors blocked) > `weak` (SNR < 4, outline CV > 0.3, or |log(rEdge/r)| > 0.5) > `ok`.
- **Prior**: μ = median log r, s = max(s_min, 1.4826·MAD)·√(1 + 1/n), with s_min = 0.25. With fewer than 3 usable seeds the result is reported as tentative, with warnings. With no usable seeds the radius falls back to touching seeds (s = 0.4), then to 0.8 % of the plate diameter (s = 0.6).
- **Appearance**: robust median/scale for contrast, SNR, edge sharpness, outline CV and Lab at the centre. The fitter currently uses only the contrast lower bound.
- **Cross-plate seeds**: the caller (or the worker) crops a patch around each seed on the reference image, at roughly the target analysis scale. The patch gets its own Lab and background. Radii are converted through the patch scale. This assumes the same magnification, and a warning says so.
- **Status line**: `calibrationSummary()` returns e.g. "7 manual examples; 6 usable for size estimation".

On the agent seeds, 141 of 148 seeds were `ok`. 1249 had 2 `weak` (hazy, low-contrast edges) and 1250 had 1 `touching`. The estimated radii agree with the foreground mask's area-equivalent radius to within 2–3 % on 1280 (9.6–10.7 vs 9.7–10.7 analysis px).

### 2.5 Methods

**W (baseline)**: mask → distance transform (smoothed σ = 1) → maxima at least 0.7·r̃ apart, plus the deepest pixel of every component → watershed on −DT → one colony per region (centroid, area-equivalent radius). No size prior beyond marker spacing and no ambiguity output.

**A (LoG)**: scale-normalised LoG on `F` at 3–5 radii spanning exp(μ ± 1.5 s). Maxima beat the neighbouring scales; NMS overlap is 0.7. The threshold is a fraction (0.2–0.55, set by sensitivity) of the median LoG response at the seeds.

**H (fitter)**, per foreground cluster:
- Candidates: DT peaks; peaks of a *core mask* (F > 0.75·seed contrast), where seams between touching colonies stay below the level; circles fitted to contour arcs between concave points, on outer and hole contours; LoG peaks at the prior scales. Between search rounds, *residual candidates* are added: DT peaks of foreground still not covered.
- Objective, in units of one typical colony (A0 = π r̃²):
  `J = (FN + FP)/A0 + α Σ E_i + β Σ huber((log r_i − μ)/s) + γ Σ App_i + λ Σ (r_i/r̃)² + ω Σ_pairs max(0, 0.7(r_i + r_j) − d_ij)²/r̃²`.
  E_i is the truncated chamfer misalignment of the disk's *exposed* boundary samples against the mask boundary (τ = max(1.5, 0.25·r̃)). Samples inside another disk, or within τ/2 outside it, count as hidden, because touching colonies show no edge between them. App_i penalises disk interiors dimmer than the seeds' lower bound and ring-like profiles such as bubbles. All terms are updated incrementally on the patch raster.
- Search: lazy greedy forward selection, where each candidate is evaluated at 4 radii; coordinate refinement of (x, y, r); a split move for over-large disks; pruning of disks whose removal lowers J; residual candidates; up to 4 rounds; then a polish step that accepts additions which only pay off after refinement.
- Existing annotations of every group are **fixed disks**. Radius comes from `geometry.r` if known; otherwise the colony under the mark is measured like a seed, and the measured centre is used for the loss only if it is within r/2 of the mark.
- Diagnostics: per-colony support m_i = J(without i) − J, reported as `score`. Runner-up K is the best removal (K−1) or the best *separate* addition (K+1; disks nested inside an existing one are excluded). The gap is in colony units. Status is `review` if gap < 0.25 and `too-large` above k_max·A0 (default 400, never hit here). Review clusters carry the alternative colony set.
- Defaults: α 0.5, β 0.6, γ 0.5, λ 0.175 (sensitivity 0.5), ω 1, Huber δ 2, s_min 0.25. They were tuned by eye on 1280, 1268, 1250 and 1293 overlays. That is not a held-out procedure (§6).

Tuning history, kept because each fix addressed a failure seen on real plates:
1. Too few candidates in merged clusters → residual and core-mask candidates.
2. Big disks swallowing touching pairs → stronger prior, split move.
3. Greedy refused a first disk when the candidate radius was off → multi-radius evaluation and polish.
4. Almost every cluster flagged for review because the K+1 runner-up was a nested duplicate → separate-colony constraint.
5. Colonies 20–25 % smaller or dimmer than the seeds were priced out → area-scaled λ, softer appearance bound, s_min 0.25.
6. Two overlapping disks on one round colony → overlap term.

### 2.6 Analysis scale

`chooseAnalysisScale` picks max(4/r_min, 8/r̃) analysis px per original px, where r_min = exp(μ − 2s) and r̃ = exp(μ), capped at 4 MP. Without a prior it uses a 2048 px long side. The original plan, "smallest colony ≥ 3–4 px", gave r̃ ≈ 6 px on these plates. At that size the core mask covered whole merged groups and the fitter could not separate touching pairs. At r̃ = 8–10 px the seams appear.

`--target-r 6` (1268/1280/1291) is about 40 % faster (fitter 1.7–2.0 s vs 2.1–3.6 s) and changes counts by 1–6 %. Without GT I can't say which is right. The default of 8 is a judgement call.

### 2.7 Public API

```ts
import { detect, createDetectorClient, chooseAnalysisScale, suggestionsToAnnotations } from './detection'

// pure, any thread
detect(input: DetectInput, onProgress?, signal?, cache?): Promise<DetectResult>
//   DetectInput = { image (RGBA at analysis scale), scale, originalWidth/Height, imageId, targetGroupId,
//                   seeds: { annotationId, imageId, x, y, patch? }[],          // patch for cross-plate seeds
//                   existing: { id, x, y, groupId, origin, r? }[],             // ALL groups, hidden too
//                   roi?: DetectionRun['roi'], settings?: Partial<DetectSettings>, runId?, includeClusterLabels? }
//   DetectSettings = { method: 'fitter'|'watershed'|'log', sensitivity 0..1, priorWidth, edgeMarginFrac,
//                      kMax, reviewGap, sMin, minUsableSeeds, fitWeights? }
//   DetectResult = { suggestions: { x, y, r, score|null, clusterId, status: 'ok'|'review' }[]   // original px
//                    clusters: { clusterId, bbox, area, fixedIds, chosenK, runnerUpK, objectiveGap,
//                                status: 'ok'|'review'|'too-large', alternative? }[]
//                    calibration: { seeds: SeedReport[], nTotal, nUsable, prior, appearance, polarity,
//                                   colorAxis, summary, tentative, warnings }
//                    roi: { source, outline (original px), shape, marginPx, area }
//                    run: DetectionRun      // imageFingerprint '' and seedImageFingerprints {} → caller fills
//                    timingsMs, peakRasterBytes, clusterLabels? }

// browser: one long-lived module worker
const detector = createDetectorClient()
const result = await detector.detect({
  source: { kind: 'blob', blob },                         // or 'bitmap' (transferred) / 'rgba' (transferred)
  originalWidth, originalHeight, imageId, targetGroupId, seeds, existing,
  remoteSeeds?: [...], remoteSources?: { [imageId]: Blob }, // cross-plate: the worker crops the patches
  settings, analysis?: { scale?, targetTypicalRadius?, maxPixels? },
}, { onProgress, signal })
```

- The worker decodes with `createImageBitmap(blob, { resizeWidth, resizeHeight, resizeQuality: 'high', imageOrientation: 'from-image' })` (Safari ≥ 15) and `OffscreenCanvas` 2D (Safari ≥ 16.4). It frees the bitmap and zeroes the canvas immediately.
- Two passes: calibrate at the preliminary scale, then re-decode at the seed-derived scale if it differs by > 15 %.
- It keeps the last decoded image and its prepared planes, so a sensitivity re-run skips decoding, Lab conversion and the ROI.
- A new `detect()` cancels the running one, which suits slider drags. `AbortSignal` rejects with `DetectionCancelled`. `detect()` yields to the event loop between stages and every ~40 ms during cluster fitting, so cancel messages get through.
- Error codes: `decode-failed`, `out-of-memory`, `internal`.
- **Not verified on hardware**: EXIF-rotated photos (whether the crop rectangle is applied before or after orientation), and Safari memory limits.

## 3. Evaluation harness (`scripts/eval/`)

```
npm run eval -- --images test_images --seeds scripts/eval/agent-seeds.json         # this report
npm run eval -- --gt project.zip [--gt-group "Colonies"] --seeds gt:5 --resample 10   # once GT exists
npm run eval:pick -- test_images/x.jpg                                                 # numbered candidates for picking seeds
```

- Decodes with `sharp` (libvips; devDependency). It applies EXIF orientation, resizes fast and writes overlays by compositing SVG. `jpeg-js` would need its own resizer and PNG encoder and is several times slower on 24 MP. `sharp` is only imported under `scripts/` and is absent from the worker bundle.
- Two-pass scale like the worker. Runs W/A/H. Writes overlay JPEGs (ROI outline, seeds coloured by quality with their estimated radius, suggestions green = ok / orange = review, magenta review clusters, red too-large regions, white GT points), a zoom on the largest cluster, `report.json` and `report.md` to `.eval-out/` (git-ignored).
- **GT metrics, implemented and unit-tested, not yet exercised on real GT.** Images are matched to the zip by SHA-256 fingerprint, then by name; image bytes inside the zip are used directly. Seeds are removed from the GT before scoring. Reported: greedy one-to-one matching at 0.6 / 1.0 / 2.0 × the typical radius (P, R, F1), count error, centre error (mean and median px), duplicate rate, per-cluster count error binned by GT colonies per cluster (0, 1, 2, 3–5, 6–20, > 20, via `includeClusterLabels`), and seed-selection sensitivity (`--resample N --resample-k k`, count and F1 spread). `--seed-jitter px` simulates click error.
- **Agent-picked seeds** (`scripts/eval/agent-seeds.json`, 7–8 per plate on 14 plates): I chose clear, isolated colonies by eye from numbered LoG candidates on downsampled overviews. They are **not ground truth**. They sit at LoG centres, so they are better centred than real clicks, and they are biased towards large, obvious colonies, exactly the bias the brief warns about. The 4 near-empty plates use seeds from 1280; 1294/1295/1297 use seeds from 1296.

## 4. Results (no GT: counts, agreement, runtime)

Node 26 on an Apple M3 Max, sensitivity 0.5, default settings. "n" is new suggestions, excluding the 7–8 seeds. Agreement is the F1 of matching two methods' suggestions within r̃. It measures consistency, not accuracy.

| image | type | r̃ (orig px) | scale | H n | W n | A n | H review clusters | H ms | W ms | A ms | H~W | H~A |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1249 | hazy, merged streaks | 44.9 | 0.18 | 140 | 25 | 89 | 6/14 | 1342 | 490 | 778 | 0.24 | 0.67 |
| 1250 | hazy, merged streaks | 55.7 | 0.16 | 86 | 30 | 97 | 6/13 | 1203 | 363 | 537 | 0.45 | 0.69 |
| 1268 | cream, loose streaks, bubbles | 25.8 | 0.34 | 213 | 227 | 258 | 64/121 | 3474 | 1923 | 3117 | 0.86 | 0.85 |
| 1269 | cream | 25.7 | 0.34 | 221 | 234 | 259 | 46/117 | 3471 | 1860 | 3041 | 0.88 | 0.88 |
| 1278 | cream | 23.4 | 0.34 | 224 | 192 | 215 | 25/87 | 3338 | 1807 | 2975 | 0.91 | 0.93 |
| 1279 | cream | 24.5 | 0.34 | 226 | 205 | 224 | 32/88 | 3461 | 1873 | 3028 | 0.93 | 0.93 |
| 1280 | cream | 28.9 | 0.28 | 205 | 173 | 224 | 26/68 | 2057 | 928 | 1617 | 0.86 | 0.90 |
| 1281 | 1 colony (cross-plate seeds) | 28.5 | 0.28 | 1 | 1 | 1 | 0/1 | 1809 | 1003 | 1787 | 1 | 1 |
| 1282 | cream | 28.0 | 0.29 | 233 | 250 | 274 | 52/98 | 2277 | 1019 | 1793 | 0.87 | 0.85 |
| 1283 | empty (cross-plate) | 28.5 | 0.28 | 0 | 1 | 2 | 0 | 1814 | 1022 | 1793 | – | – |
| 1284 | empty, bubble (cross-plate) | 28.5 | 0.28 | 0 | 2 | 5 | 0 | 1802 | 1019 | 1801 | – | – |
| 1285 | empty, bubbles (cross-plate) | 28.5 | 0.28 | 0 | 2 | 3 | 0 | 1818 | 1022 | 1802 | – | – |
| 1287 | cream | 28.0 | 0.29 | 141 | 146 | 158 | 36/82 | 2066 | 997 | 1800 | 0.90 | 0.89 |
| 1290 | cream, bubbles | 26.3 | 0.34 | 212 | 252 | 284 | 56/109 | 3606 | 1783 | 3155 | 0.81 | 0.79 |
| 1291 | cream, rim drops | 26.2 | 0.34 | 195 | 252 | 273 | 48/130 | 3587 | 1853 | 3117 | 0.82 | 0.79 |
| 1292 | fluorescent, dense | 19.8 | 0.41 | 286 | 131 | 223 | 3/17 | 4445 | 1780 | 3472 | 0.58 | 0.77 |
| 1293 | fluorescent, dense | 18.8 | 0.41 | 333 | 139 | 220 | 10/31 | 4404 | 1797 | 3444 | 0.46 | 0.68 |
| 1294 | fluorescent (cross-plate) | 19.7 | 0.41 | 315 | 143 | 269 | 6/32 | 4667 | 1971 | 3690 | 0.52 | 0.76 |
| 1295 | fluorescent (cross-plate) | 19.7 | 0.41 | 220 | 126 | 208 | 17/34 | 4222 | 1979 | 3679 | 0.63 | 0.82 |
| 1296 | fluorescent, dense | 19.7 | 0.41 | 320 | 183 | 254 | 11/37 | 4450 | 1818 | 3516 | 0.64 | 0.77 |
| 1297 | fluorescent (cross-plate) | 19.7 | 0.41 | 228 | 130 | 190 | 11/30 | 4323 | 2013 | 3719 | 0.61 | 0.77 |

### 4.1 Qualitative observations from the overlays

- **Isolated and loosely touching colonies (cream plates)**: all three methods find essentially all of them, and they agree at F1 0.81–0.93. On 1280 every visible colony in the largest cluster was covered after tuning. Ambiguous spots were flagged for review, not forced.
- **Near-empty plates**: H gives 0 false positives on 1283/1284/1285 and finds the single colony on 1281. A picks up 2–5 bubbles or dust specks and W 1–2. The appearance term (ring-like penalty) and the mask threshold suppress bubbles in H.
- **Dense merged streaks with seeds from large isolated colonies (1249, 1250)**: this is the main failure mode. Streak colonies are about half the seed radius. H under-counts there and uses oversized disks (on 1250 one disk covered about 8 small colonies at one point). W collapses whole streaks into a few regions (25–30 suggestions on plates with well over 150 colonies). This is the seed-bias problem from the brief. The calibration currently does *not* warn about it, because the warning only fires when the seed sizes are nearly identical.
- **Fluorescent plates**: H suggests 1.5–2.3× more than W and 1.1–1.5× more than A. The crop on 1293 shows that H resolves many small colonies in the dense field that W merges and A misses. It also shows H **over-splitting a large blurry colony** (not like the seeds) into several small disks, where W and A put one circle. I can't tell which count is closer without GT.
- **1268 (small, slightly dimmer colonies near the streaks)**: after the fixes H still misses a few dim, smaller-than-seed colonies that W finds. Its count is close to W's on that crop (56 vs 58), but on different colonies.
- **Review flags**: on cream plates 21–55 % of fitter clusters are flagged (`reviewGap` 0.25). Isolated colonies have a median gap of about 0.5, small ones down to 0.15. Pairs and triples often have gaps under 0.1. Some flags are genuine 1-vs-2 ambiguity, but the rate is too high for a good review UX. The threshold needs GT (§6).
- **Rim**: after the adaptive margin, no rim false positives on any plate. Before it, 1293 had about 60 along the glowing wall. Colonies inside the excluded band (2.7–5.4 % of the plate width) are never suggested; the UI must say so.

### 4.2 Stability

**Seed resampling** (6 random subsets of 4 of the 7 agent seeds; total count = suggestions + existing seeds):

| image | H | W | A |
|---|---|---|---|
| 1250 (hazy streaks) | 113 ± 36 (87–181) | 40 ± 2.5 | 85 ± 11 |
| 1268 | 219 ± 6.7 | 233 ± 3.0 | 270 ± 2.4 |
| 1280 | 210 ± 2.7 | 178 ± 0.8 | 232 ± 1.7 |
| 1291 | 205 ± 4.8 | 260 ± 3.3 | 279 ± 3.1 |
| 1296 (fluorescent) | 333 ± 53 (239–374) | 189 ± 18 | 261 ± 21 |

On the cream plates H is stable to ±2–3 %. On plates with dense streaks of colonies unlike the seeds, H is **unstable**: ±32 % on 1250 and ±16 % on 1296. The prior moves with the subset and the fit follows it. The brief asked for exactly this test, and it is a real weakness.

**Click jitter** of 15 original px (about 0.5–0.75 r): counts changed by ≤ 3 % on 1268/1280/1291. On 1296, 3 of the 7 seeds dropped to non-`ok` and H went from 320 to 250 (−22 %). On 1250, H went from 86 to 100.

### 4.3 Runtime and memory

- **Node, M3 Max**: H 1.2–4.7 s, W 0.4–2.0 s, A 0.5–3.7 s per image at 0.6–3.3 MP analysis size, plus about 3 s for the preliminary calibration pass at 2048 px (`pass1`, harness only). Breakdown at 2.8 MP (1268): prepare 0.19 s, calibrate 1.27 s (two background passes, 3 large-σ blurs each, seed profiles), method 2.0 s.
- **iPad projection (not measured)**: Safari/JSC on M1/M2 iPads is typically 1.5–2.5× slower than Node on an M3 Max for this kind of typed-array code. A-series iPads are slower still. Expect **about 3–12 s** for H on the fluorescent plates and about 2–8 s on the cream plates, including the preliminary pass. That misses the 1.5 s target in `automated-counting.md` §6.5. Slider re-runs skip decode, Lab and ROI but still redo calibration and the method.
- **Memory**: the estimated peak raster footprint is 44–58 MB at 0.6–0.8 MP, 133–142 MB at about 1.7 MP, about 200 MB at 2.8 MP and about 287 MB at 3.3 MP. Most of it is the 5-plane LoG stack, 3 Lab planes and 3 background planes. Node's process RSS reached 1.3 GB, but that includes sharp/libvips decoding of the full 24 MP JPEGs. **The 3.3 MP case is near the ~300 MB iPad budget.** Options: cap at 2.5 MP on iPad (`analysis.maxPixels`), free the LoG stack after candidate generation, compute the background on a 4× smaller grid, or tile.

## 5. Deviations from the plan

1. **ROI**: region growing + convex hull + adaptive rim band instead of a Hough circle (square plates). Hough is implemented and tested but unused.
2. **Analysis scale**: also requires a typical radius ≥ 8 px, not only the smallest colony ≥ 3–4 px.
3. **Objective additions** not in the brief: area-proportional count penalty, pairwise overlap penalty, separate-colony runner-up, residual/core-mask candidates, split and polish moves. They follow its spirit and are documented in `fitter.ts`.
4. **Appearance**: only the contrast lower bound and a ring-profile penalty are used in J. The full per-feature ranges are computed and stored but not yet scored.
5. **Greedy plus local moves**, no exact/ILP selection (as the research note anticipated).
6. **Fixed manual disks** may use a locally re-measured centre (within r/2) for the loss only. The annotation itself never moves.
7. **`too-large`** never triggered (k_max = 400 colony areas). Dense streaks are fitted and flagged per colony instead.

## 6. What needs GT to decide

- Whether H actually beats W on touching clusters without losing on isolated colonies. This is the adoption criterion. Per-cluster count error by cluster size is implemented and waits for data.
- All weights (α β γ λ ω, Huber δ, s_min) and the mask fraction. They were tuned by eye on 4 plates. They must be fixed on a development split and scored on held-out plates.
- `reviewGap`: currently too many review flags. Choose it so flagged clusters are the ones where the chosen K is often wrong.
- Analysis resolution (r̃ = 6, 8 or 10 px): accuracy vs runtime.
- The fluorescent plates (H ≈ 2× W): which count is closer?
- Seed bias: does adding 2–3 streak colonies as seeds fix 1249/1250/1296? The harness supports `--seeds gt:5:random`. A test of "user-like" seed sets is needed.
- Matching radius choice (0.6 / 1.0 / 2.0 r̃ are all reported).

Please provide fully annotated project zips that include at least one hazy plate (like 1249/1250), one cream plate and one fluorescent plate. Mark every colony, including those in streaks, and note which plates are complete. Partially annotated plates make every unmarked true colony look like a false positive.

## 7. Proposed UI integration (later phase, after the UX work)

**State (`src/state`)**: a per-image, in-memory *suggestion layer*: `{ runId, result: DetectResult, rejected: Set<index>, settings }`. It is not part of the store's undoable history, not saved, and not counted. Drop it on image switch or when `sourceMismatch` is set. Refuse to run while the target group is locked or the image has `sourceMismatch`.

**Action "Find similar in this group"**:
- seeds = manual annotations of the active group on this image (if none, offer a reference plate: the user picks an image and its seeds become `remoteSeeds` plus `remoteSources`);
- existing = all annotations of every group, with `geometry.r` where known;
- target group = the active group;
- ROI = the user's region if drawn, otherwise auto.

Call `detector.detect()` with a progress bar and a Cancel button, then show `calibration.summary` and its warnings ("7 manual examples; 6 usable for size estimation"; "results are tentative"; "rim band excluded: mark edge colonies manually").

**Viewport layer (`src/viewport`)**: a read-only overlay prop `suggestions: { x, y, r, status, clusterId }[]`. Draw hollow rings in a neutral "pending" colour, dashed for `review`. Draw review clusters as an outline with a "2 or 3?" chip. Draw `roi.outline` and the rim band faintly. Optionally show seed rings coloured by quality. Taps on a ring report `onSuggestionTap(index)`. The viewport stays a pure view.

**Review UX**:
- *Accept all ok*: accepts every `ok` suggestion and leaves `review` clusters pending.
- *Accept in cluster/region* (lasso) and *tap to reject* (adds to `rejected`, kept as negatives for the run record, Phase 2).
- *"2 or 3?"*: shows `cluster.alternative`. Accepting either replaces that cluster's pending set.
- *Sensitivity* and *size tolerance* (`priorWidth`) sliders re-run through the same worker (cached planes; a newer run cancels the older). Show "N suggested, not counted".
- Never auto-accept. Never include pending suggestions in counts or CSV.

**Accept → one undo step**:

```ts
const anns = suggestionsToAnnotations(selected, { groupId, run: result.run, at: now(), newId })
const run = { ...result.run, imageFingerprint: image.fingerprint,
              seedImageFingerprints: crossPlate ? { [refId]: ref.fingerprint } : undefined,
              negatives: rejected.map(i => ({ x: s[i].x, y: s[i].y })) }
editor.annotations.applyBatch(imageId, anns.map(a => ({ kind: 'add', annotation: a })), { label: `Accept ${anns.length} suggestions`, detectionRun: run })
```

Each annotation gets `origin: 'automated'` (immutable), `reviewStatus: 'accepted'`, `lastEditSource: 'automated'`, `detector: { name: run.method, version, runId, params: { clusterId, score, status }, confidence: null }` and `geometry: { kind: 'circle', r, source: 'fit' }`. The editor's `applyBatch(imageId, ops, { label, detectionRun })` already records the run in `ImageAnnotations.detectionRuns` in the same undo step and validates it (fingerprint, target group), so no editor change is needed beyond the suggestion layer. Pruning of runs that no kept annotation references is still open. Before applying, re-check duplicates against the *current* annotations, since they may have changed during the run, and check locked groups via `checkOps`.

**Seed geometry (optional)**: write `geometry: { kind: 'circle', r: radiusPx, source: 'seed-estimate' }` to the seed annotations so their rings can be shown. This does not change `origin`, `lastEditSource` or `manuallyAdjusted`.

## 8. Model changes

None. `DetectionRun`, `DetectionSeed`, `AnnotationGeometry`, `DetectorProvenance` and `Annotation.geometry` in `src/model/types.ts` were sufficient. Method-specific data goes in `run.prior`, `run.settings` and `run.diagnostics`. `src/detection` imports model types only.
