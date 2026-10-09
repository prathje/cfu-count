# Colony detection: Phase 0 + 1a + 1b results

Status: 2026-10-09. The detectors are implemented in `src/detection/` and the evaluation harness in `scripts/eval/`. The UI integration is done (§7.1). **There is no ground truth yet.** Every number below is a count, a runtime or an agreement between methods, never an accuracy. Seeds were picked by an AI agent, not by a microbiologist (see §3).

Read with: `docs/research/automated-counting.md` (options and the adopted plan) and `colony-fitting-method-brief.md` (the mainline method).

> **Section S (2026-10-09, third phase: a true per-cluster K sweep) supersedes §0 where they conflict**, and §0 supersedes §1–§8. Superseded statements in §0 are marked *(superseded by §S)*.

> **Section SC (2026-10-09, seed calibration in dense streaks) supersedes the seed-radius description in §S, §0 and §2 where they conflict.**

## SC. Seed calibration in dense streaks (2026-10-09)

Supervisor report on capture001247 (6016 × 4016; owner: ~170 colonies in the upper-left streak, ~30 large colonies in the lower half): with seeds on the large isolated colonies the fitter placed circles about twice too large across the streaks (111 for the whole plate). With 6 seeds on small colonies inside the streak the calibration said "6 manual examples; 0 usable": every seed was flagged *touching* with a radius of 164–209 px (true ≈ 25–40 px), the prior was null and the fitter fell back to 18 suggestions. Marking a few colonies in the streak is what users do on crowded plates, so this case has to work. Still no ground truth: the owner's numbers are approximate region totals.

### SC.1 Root cause

`measureSeed` searched each of 24 sectors for the half-level crossing between the seed's peak and the background. Inside a streak the brightness never falls to half until the streak's outer edge, so the radius ran to the cluster boundary. Sectors that fell and rose again were marked as touching but still counted, and any seed with ≥ 30 % such sectors was 'touching' and excluded from the prior. A seam between two touching colonies (a 5–25 % dip on these blurry photos) was never treated as a boundary.

### SC.2 Fix (`src/detection/calibrate.ts`)

1. **First boundary along 32 rays.** Each ray (three sub-rays, ~1 px smoothing) stops at the first of: an *edge* (the profile falls below half-way between the ray's running maximum and the background) or a *seam* (it drops ≥ max(8 % of the ray's contrast, 4 σ) below the running maximum and rises again by ≥ max(3 %, 2 σ)); the seam position is the valley minimum. Rays with no boundary, or with one outside 0.6–1.6 × the median ray radius (they ran into a neighbour without a valley), are left out. The radius is the median of the remaining rays.
2. **Re-centring on the colony.** A Kåsa circle through the inlier boundary points, refitted with every boundary point near it, moves the centre (up to three times) as long as the circle contains the click and is at most twice the current radius. A click 14 px off the centre of an r = 18 colony now converges to the centre (previously the shift limit stopped it).
3. **Touching seeds are usable.** 'touching' = ≥ 30 % of rays seam-bounded or without boundary. With a radius, ≥ 1/3 of the rays as inliers, ≤ 50 % without boundary, SNR ≥ 4 and CV ≤ 0.35 the seed feeds the prior at weight 0.6 (`TOUCHING_WEIGHT`; weighted median and MAD). 'edge', 'glare' and 'weak' are unchanged. The prior is null only if no seed has a usable radius.
4. **Size spread in plain words.** If usable seeds differ by ≥ 1.8× the report adds "Examples vary in size (radius X–Y px), so the allowed size range is wide. If there are two kinds of colonies, mark a few of each." (the MAD in log radius already widens s).
5. **Resolution.** Calibration runs on the preliminary image (long side 2048, scale 0.34 here, streak colonies ≈ 10 px radius) and again on the final crop, where the typical seed colony is 8 px. Seams of 1–3 px at full resolution are partly averaged away at 0.25 but the 5–25 % dips on these photos survive; separate full-resolution patches around each seed were not needed for 1247/1250 and were not added (they would mean an extra decode per seed in the browser). With the correct streak radii the analysis scale rises from 0.114 (run A) / 0.34 (run B, no prior) to 0.249.

### SC.3 Size heterogeneity: per-cluster priors (`priorsForClusters`, used by the fitter)

With seeds only inside the streak (r ≈ 32 px), the ~30 large isolated colonies of 1247 (r ≈ 55–100 px) were each split into a "flower" of about 7 circles (total 579). The fitter now uses a size prior per connected cluster, in this order:

1. **Marks inside the cluster** (seeds and existing annotations, radius measured like a seed): the prior moves towards their median, either way.
2. **Mainly clean, near-perfectly round isolated colonies**, measured automatically at brightness maxima (CV of ray radii ≤ 0.06, at least 30 % of the cluster's measurements): the prior can only grow. A clump of 4 colonies overlapping by 30–40 % without seams measures as one round colony with CV ≈ 0.10, so the threshold keeps the 45 split fixtures exact; a streak also contains a few round lobes, hence the 30 % share.
3. **Crowded clusters (≥ 2 typical colonies) without marks** use the marks of all crowded clusters, so marks in one streak set the size of the other.
4. Otherwise the seed prior.

The shift is d · n / (n + 0.5) for a log-size difference d and evidence n (3 per mark or round colony, capped at 8), faded in by a smoothstep between |d| = s/2 and s, and s is widened to ≥ |d|/2. The table sizes and the "too large" guard keep the seed prior.

**Tried and rejected: shrinking the prior from automatic measurements.** Measuring every brightness maximum like a seed and moving crowded clusters towards a low quantile of those radii brought 1250 (agent seeds on the lower colonies) to 128–135 against the owner's 136. On the plates whose seeds are representative it shrank the prior as well: cream plates +25–55 % (1280: one extra circle on a chain of four), the empty plate 1284 0 → 15, and on the fluorescent plates the streak became "too large" (348 → 10). The ratio of the automatic crowded-colony radius to the seed prior was 0.87 (median) on 1247, where the owner's count implies about 0.5, and 0.72–0.77 on the cream plates, where §S found the result right. The measurements are biased both ways (blurry streaks: merged lobes, too large; crisp touching colonies: seam radius, too small), so they carry no usable signal for "smaller than the seeds". Only marks can say that.

### SC.4 Before / after (fitter, tuned, sensitivity 0.5, worker path)

Region = suggestions + seeds inside the box. 1247 box: x 1960–2980, y 500–1900 (the supervisor's reading). 1250 box: x 2050–3150, y 350–2050 (my reading of "upper-left streak/area"; it contains the whole upper-left streak and nothing else, and matches the region tool's lasso bbox x 2120–3060, y 420–1960). Check script: `node scripts/eval/streak-check.ts` (seed files `scripts/eval/streak-seeds.json`, `scripts/eval/isolated-seeds-1247.json`; images stay local).

| case | usable seeds before → after | streak seed radii after (px) | region count before → after (owner) | plate suggestions before → after | review after |
|---|---|---|---|---|---|
| 1247, 6 seeds inside the streak | 0 → 6 of 6 (164–209 px, all 'touching') | 26, 28, 52, 34, 32, 52 | 8 → **204** (~170, +20 %) | 18 → 445 | 10 % |
| 1247, 6 seeds on lower isolated colonies | 5 → 5 of 6 | – | 44 → 46 (~170, −73 %) | 111 → 116 | 6 % |
| 1250, 7 agent seeds (lower isolated colonies) | 6 → 7 of 7 | – | 68 → 77 (136, −43 %) | 145 → 181 | 8 % |
| 1250, 7 seeds inside the upper-left streak | 2 → 6 of 7 | 37, 37, 35, 65, 67, 40, 32 | 122 → **127** (136, −7 %) | 327 → 299 | 7 % |

By eye (zoomed overlays): with streak seeds, 1247's streak circles are now ~30 px instead of ~2× the colonies, but inside the parts of the streak without visible seams they form a regular carpet rather than following lobes (the count there is area / typical colony area); the lower large colonies get one circle each (before the per-cluster priors: 7 each). On 1250 with streak seeds the second streak, which has no seeds, gets the same size; a few medium colonies in the lower half are still split in two.

21-plate run (agent seeds, `--rerun`; B = commit 947f2c4, A = this change; same machine, sequential runs):

| plate | B n | A n | review B → A | usable seeds B → A | r̃ px B → A | first run ms B → A | re-run ms B → A | stable | adapted clusters |
|---|---|---|---|---|---|---|---|---|---|
| 1249 | 200 | 181 | 11 → 8 % | 5 → 7 | 43.6 → 45.9 | 3153 → 3043 | 28 → 25 | yes | 2 |
| 1250 | 145 | 181 | 14 → 8 % | 6 → 7 | 56.1 → 49.1 | 2724 → 2963 | 21 → 21 | yes | 4 |
| 1268 | 265 | 264 | 3 → 5 % | 7 → 7 | 25.8 → 25.7 | 3038 → 3300 | 54 → 54 | yes | 0 |
| 1269 | 265 | 266 | 6 → 6 % | 7 → 7 | 25.6 → 25.5 | 3177 → 3271 | 53 → 56 | yes | 0 |
| 1278 | 256 | 257 | 6 → 7 % | 7 → 7 | 23.4 → 23.1 | 3359 → 3588 | 65 → 63 | yes | 0 |
| 1279 | 259 | 260 | 5 → 8 % | 7 → 7 | 24.5 → 24.4 | 3305 → 3385 | 60 → 60 | yes | 2 |
| 1280 | 243 | 245 | 11 → 13 % | 7 → 7 | 28.9 → 28.9 | 3126 → 3102 | 50 → 43 | yes | 0 |
| 1281 (1 colony) | 1 | 1 | 0 → 0 % | 7 → 7 | 28.6 → 28.9 | 1846 → 1770 | 44 → 43 | yes | 0 |
| 1282 | 288 | 284 | 9 → 9 % | 7 → 7 | 28.0 → 28.0 | 3214 → 3342 | 45 → 45 | yes | 0 |
| 1283 (empty) | 0 | 0 | – | 7 → 7 | 28.6 → 28.9 | 1725 → 1734 | 45 → 43 | yes | 0 |
| 1284 (empty) | 0 | 0 | – | 7 → 7 | 28.6 → 28.9 | 1769 → 1740 | 46 → 43 | yes | 0 |
| 1285 (empty) | 0 | 0 | – | 7 → 7 | 28.6 → 28.9 | 1762 → 1782 | 43 → 43 | yes | 0 |
| 1287 | 167 | 166 | 8 → 6 % | 7 → 7 | 27.9 → 28.1 | 2454 → 2511 | 47 → 46 | yes | 0 |
| 1290 | 285 | 284 | 7 → 8 % | 7 → 7 | 26.3 → 26.3 | 3247 → 3349 | 51 → 51 | yes | 0 |
| 1291 | 259 | 260 | 7 → 11 % | 7 → 7 | 26.2 → 26.2 | 3012 → 3072 | 51 → 53 | yes | 0 |
| 1292 (fluor.) | 348 | 334 | 6 → 12 % | 7 → 7 | 19.8 → 19.9 | 4849 → 4898 | 84 → 82 | yes | 2 |
| 1293 (fluor.) | 392 | 385 | 13 → 8 % | 8 → 8 | 18.9 → 18.9 | 5590 → 5569 | 95 → 95 | yes | 4 |
| 1294 (fluor.) | 401 | 377 | 6 → 7 % | 7 → 7 | 19.7 → 20.0 | 5663 → 5593 | 90 → 83 | yes | 4 |
| 1295 (fluor.) | 284 | 266 | 9 → 9 % | 7 → 7 | 19.7 → 20.0 | 4698 → 4665 | 85 → 85 | yes | 1 |
| 1296 (fluor.) | 393 | 364 | 12 → 10 % | 7 → 7 | 19.7 → 20.0 | 5401 → 5291 | 84 → 81 | yes | 12 |
| 1297 (fluor.) | 294 | 267 | 8 → 4 % | 7 → 7 | 19.7 → 20.0 | 4827 → 4745 | 86 → 82 | yes | 7 |
| **total** | **4,745** | **4,642** | | | | | | **21 / 21** | |

- Cream plates (1268–1291) and the empty plates are unchanged within ±4. The empty plates stay at 0.
- The fluorescent plates lose 7–29 suggestions each. In the overlays I checked (1295, 1296) these are large single colonies that B split into "flowers" of 5–9 circles (one colony on 1295: 9 circles → 1; a chain on 1296: 33 → 19 in a 420 × 530 px box, each circle now on one colony). That is the size-heterogeneity fix working on plates whose seeds are small.
- 1249/1250: two touching seeds are now usable. On 1250 the prior falls from 56 to 49 px and the count rises 145 → 181, but the upper-left streak (77) is still far below the owner's 136: the seeds are large isolated colonies and nothing tells the detector that the streak's colonies are smaller (SC.3). With 7 seeds in the streak it is 127.
- Synthetic fixtures (`scripts/eval/fixtures.ts`): 45/45 exact, 0 in review, for both `tuned` and `brief`. Slider re-runs reproduce exactly on all 21 plates.
- Cost: one extra measurement per brightness maximum for the round-colony evidence (0.1–0.4 s in isolation); first runs stay within −7 … +9 % of B, re-runs unchanged.

Regression tests (`src/detection/calibrate.test.ts`): seeds inside hex-packed streaks of r = 8 disks at 2.0, 1.85 and 1.7 r spacing (deep, shallow and very shallow seams) measure within ±20 % and stay usable; a click 10–14 px off the centre of an r = 18 colony re-centres; a seamless merged neighbour does not inflate the radius; weighted prior and the size-spread note; per-cluster priors (marks move it both ways, a second unmarked streak follows the marks, round colonies only grow it, a clump with CV 0.1 and a streak with a few round lobes do not); and two end-to-end `detect()` plates with a 40-colony streak and four large colonies: streak seeds → streak within ±20 % and one circle per large colony; seeds of both kinds → the same.

### SC.5 Remaining issues

- **Seeds only on large isolated colonies still under-count streaks** (1247: 46 of ~170, 1250: 77 of 136). The fix is to mark a few colonies inside the streak; the calibration report should say so in the UI when examples are all isolated and the plate has large crowded areas (not done: it needs a reliable "streak colonies look smaller" signal, which SC.3 shows the automatic measurements are not).
- **Streak seeds over-count 1247 by ~20 %** (204 vs ~170). Where a streak shows no seams the fitter tiles it at the prior size; the count follows the prior (weighted median 32 px, the one isolated small seed counts most). Scaling by area, a 33 px prior (equal seed weights) would give about 190; I did not tune this on one plate.
- **One streak seed per plate stays unusable** when its rays run into merged neighbours on more than half the directions (1250: 1 of 7).
- The 1250 region is my reading of the owner's description; the region tool's Compare with the owner's marks will give a real per-colony check.


## S. True per-cluster K sweep (2026-10-09)

The product owner asked for a real sweep over K per cluster instead of the greedy fit with small K comparisons, and for slider re-runs that cannot depend on history. Still no ground truth: every number below is a count, a review share, a runtime or a fixture result on the same 21 plates and agent-picked seeds as §0.

### S.1 Review of the §0 retune

Fixed (with regression tests):
- **History-dependent results.** In §0 a re-run whose best K landed on the edge of a group's table extended the table in the cached fit state. Returning to an earlier slider value then gave a different result. With the harness's new check (sensitivity 0.5 → 0.6 → 0.5), 7 of 21 plates (all six fluorescent plates and 1250) changed under the committed `tuned` detector, 10 of 21 under `brief`. The extension also fitted the new K against a state that later groups had already changed, so its objective was not comparable with the rest of the table. The tables are now built once and are read-only (test: `clusters.test.ts`, "slider re-runs are deterministic"). Now 21 of 21 plates reproduce exactly.
- **Reference images missing from the cache keys.** The plan key and the seed-patch key ignored the reference image's bytes, so a reference plate replaced under the same id could reuse a stale plan or calibration. The plan key now includes `remoteFingerprints`, and each patch carries `sourceFingerprint`, which the calibration key includes (test: `worker.test.ts`).
- **The UI sent no fingerprints.** `src/state/assist/seeds.ts` now passes `imageFingerprint` and `remoteFingerprints`. Before this, the worker's keys fell back to blob size and type.
- **Calibration speed.** The vertical box-blur pass walked columns (cache misses on multi-megapixel planes). Background estimation also blurred the same weight mask three times. Fixing both saves ~0.6 s per plate with identical results.

Reported, not changed:
- The worker handles requests concurrently. A cancelled run keeps going until its next checkpoint (≤ ~40 ms) and shares the single-slot `DetectorCache` with the new run. Cancelled runs never write the fitter slot, so I found no wrong result, only wasted work.
- The first run calibrates twice: once on the preliminary image (pass 1), once on the plate crop. That is by design but costs ~0.5–1 s.
- Floating-point results (`Math.cos`, summation order) can differ between JS engines. Node and Safari may therefore differ in rare ties. On one engine the results are deterministic.
- The suggestion post-filter (ROI, near existing colonies) runs after the K decision, so a unit's K is decided with a colony that is filtered out later. `reconcileClusters` fixes the counts the UI sees. This is unchanged from §0.

### S.2 The sweep (`src/detection/methods/fitter.ts`)

1. **Units (sub-clusters).** Watershed of the lightly smoothed contrast plane plus a little distance-transform depth, flooded from the maxima of both. Cuts therefore follow the darker seams between colonies: inside a dense streak the mask's distance transform has no seams, but brightness does. Neighbouring basins merge only if there is evidence of neither a seam (brightness saddle ≥ 0.85 × the dimmer peak) nor a neck (distance saddle ≥ 0.7 × the shallower depth), up to 6 typical colonies. Basins below 0.35 colonies join their brightest neighbour. A unit above 10 colonies is cut by k-means, so the sweep always applies and the greedy path is gone. Units are fitted independently. Covering another unit's pixels costs half a background pixel; leaving them uncovered costs nothing. A first version that partitioned on the distance transform alone cut colonies in half inside streaks and produced duplicates (a 0 %-overlap triangle came out as 4).
2. **Sweep.** K_est = open area / A0 (A0 from the seed prior). For **every K from 0 to K_max = min(⌈2 K_est⌉ + 2, 30)**, the best K-circle configuration is found from up to five starts:
   - the best K−1 configuration plus a disk at the deepest uncovered point;
   - farthest-point k-means on the unit's deep pixels;
   - the top-K core-mask and distance peaks;
   - one or two k-means++ starts from a seeded RNG (mulberry32, seeded by the cluster's position and the unit index).

   Each start is jointly refined by coordinate descent on all (x, y, r). The full multi-start runs for K ≤ ⌈1.5 K_est⌉ + 2; above that, only the augmented start runs. A backward pass follows (K+1 minus its weakest disk, refined). The range is extended while the best K at λ = 0 (the highest sensitivity) sits on its upper edge. Every start type wins a sizeable share of the final per-K bests (on 1294: k-means 38, backward 36, augmented 25, peaks 24, random 22), so none was dropped.
3. **Tables.** The best 3 distinct configurations per K are stored with their λ- and prior-free objective. A slider change re-scores: best = minimum over all K; **runner-up = the best configuration of any other K** (not only K±1).
4. **Review = instability.** A unit is in review when its chosen K changes if the sensitivity moves by ±0.05 or the size tolerance by ±10 % (`settings.reviewStability`, default 0.05). The question it shows is "does the count survive a nudge of the slider?". The old relative-gap criterion became meaningless with the sweep: the sweep finds a near-optimal alternative for every K, so gaps shrank to 0.004–0.03 and a fixed threshold of 0.03 put 25–50 % of streak suggestions in review. `reviewGap` remains as an optional extra criterion (default 0).
5. **Recall bias for "colony or nothing?"** If a unit's best explanation is empty but colonies cost less than 0.05 colony units more, or the empty choice is unstable, the colonies are suggested with status ok. Rejecting them costs a tap. This recovered a dim colony on 1280 that the sweep had dropped. The empty plates 1283–1285 stay at 0 suggestions.
6. **Speed.** ΔJ of a candidate disk is now computed read-only (no insert/remove), and the trig tables are cached.

### S.3 Before / after

B = committed defaults before this phase (`tuned`, §0). S = sweep, `tuned` (new default). Sb = sweep, `brief`. Review = share of suggestions in review regions (regions, largest region in colonies). Under-split = clusters with area ≥ 1.8 × placed colonies × A0 / area holding at least one more prior-sized colony than placed (`underSplitStrict`). Stable = sensitivity 0.5 → 0.6 → 0.5 reproduces the result. Node 26, Apple M3 Max, through the worker path including decode.

| plate | B n | S n | Sb n | review B | review S | review Sb | under-split B / S | first run ms B → S | re-run ms B → S | stable B / S |
|---|---|---|---|---|---|---|---|---|---|---|
| 1249 (hazy) | 187 | 200 | 209 | 32 % (19, 5) | 11 % (4, 8) | 19 % (8, 8) | 1/1 · 2/2 | 3352 → 3235 | 30 → 28 | yes / yes |
| 1250 (hazy) | 142 | 145 | 142 | 33 % (14, 6) | 14 % (4, 9) | 46 % (12, 8) | 1/1 · 1/1 | 2988 → 2668 | 56 → 23 | NO / yes |
| 1268 | 260 | 265 | 307 | 5 % (7, 3) | 3 % (4, 3) | 21 % (25, 7) | 1/1 · 0/0 | 3258 → 3129 | 57 → 52 | yes / yes |
| 1269 | 266 | 265 | 303 | 5 % (7, 3) | 6 % (5, 5) | 20 % (24, 6) | 0/0 · 0/0 | 3347 → 3084 | 54 → 54 | yes / yes |
| 1278 | 252 | 256 | 267 | 13 % (12, 4) | 6 % (5, 4) | 9 % (11, 4) | 0/0 · 0/0 | 3362 → 3309 | 62 → 61 | yes / yes |
| 1279 | 257 | 259 | 275 | 6 % (6, 5) | 5 % (5, 7) | 16 % (17, 7) | 1/1 · 1/1 | 3305 → 3109 | 57 → 57 | yes / yes |
| 1280 | 241 | 243 | 259 | 12 % (11, 4) | 11 % (7, 6) | 20 % (15, 7) | 0/0 · 0/0 | 3139 → 2953 | 48 → 45 | yes / yes |
| 1281 (1 colony) | 1 | 1 | 1 | 0 % | 0 % | 0 % | 0/0 · 0/0 | 2557 → 1687 | 45 → 43 | yes / yes |
| 1282 | 283 | 288 | 327 | 8 % (9, 4) | 9 % (8, 7) | 24 % (32, 6) | 0/0 · 0/0 | 3264 → 3187 | 48 → 48 | yes / yes |
| 1283 (empty) | 0 | 0 | 1 | 0 % | 0 % | 0 % | 0/0 · 0/0 | 2542 → 1723 | 44 → 44 | yes / yes |
| 1284 (empty) | 0 | 0 | 0 | 0 % | 0 % | 0 % | 1/1 · 1/1 | 2561 → 1718 | 41 → 43 | yes / yes |
| 1285 (empty) | 0 | 0 | 0 | 0 % | 0 % | 0 % | 0/1 · 0/0 | 2562 → 1696 | 45 → 43 | yes / yes |
| 1287 | 164 | 167 | 186 | 7 % (7, 3) | 8 % (6, 4) | 25 % (18, 5) | 0/0 · 0/0 | 2790 → 2413 | 46 → 46 | yes / yes |
| 1290 | 274 | 285 | 332 | 8 % (12, 3) | 7 % (7, 4) | 17 % (25, 7) | 2/2 · 0/2 | 3265 → 3239 | 60 → 52 | yes / yes |
| 1291 | 253 | 259 | 309 | 5 % (8, 4) | 7 % (6, 5) | 23 % (29, 7) | 0/0 · 0/0 | 3225 → 2937 | 50 → 50 | yes / yes |
| 1292 (fluor.) | 350 | 348 | 379 | 20 % (27, 5) | 6 % (6, 6) | 15 % (22, 5) | 0/1 · 0/0 | 4912 → 4854 | 96 → 82 | NO / yes |
| 1293 (fluor.) | 388 | 392 | 413 | 26 % (35, 5) | 13 % (10, 10) | 24 % (28, 9) | 4/3 · 3/1 | 5258 → 5229 | 145 → 94 | NO / yes |
| 1294 (fluor.) | 410 | 401 | 431 | 25 % (34, 5) | 6 % (5, 7) | 25 % (33, 8) | 1/1 · 0/0 | 5638 → 5435 | 162 → 90 | NO / yes |
| 1295 (fluor.) | 275 | 284 | 292 | 20 % (21, 6) | 9 % (5, 7) | 28 % (20, 9) | 3/1 · 1/0 | 4646 → 4590 | 116 → 84 | NO / yes |
| 1296 (fluor.) | 408 | 393 | 418 | 30 % (42, 6) | 12 % (10, 7) | 17 % (24, 7) | 4/2 · 3/2 | 5160 → 5222 | 119 → 83 | NO / yes |
| 1297 (fluor.) | 298 | 294 | 317 | 27 % (26, 5) | 8 % (5, 7) | 18 % (16, 6) | 0/2 · 0/0 | 4958 → 4640 | 122 → 87 | NO / yes |
| **total** | **4,709** | **4,745** | **5,168** | | | | **19/18 · 12/10** | | | **14 / 21 stable → 21 / 21** |

The committed `brief` variant, for reference: 5,093 suggestions, review 17–37 % on plates with colonies (100 % on 1285), re-runs 43–230 ms, not stable on 10 plates.

Synthetic fixtures (`node scripts/eval/fixtures.ts [--objective brief]`; chains of 2–6, triangle, square, pentagon, 2×3 grid at 0/10/20/30/40 % overlap, 45 cases):

| | exact count | in review | a true colony missed |
|---|---|---|---|
| B (tuned) | 44/45 (chain of 6 at 40 % → 5) | 1 (chain of 4 at 40 %) | 1 |
| B (brief) | 45/45 | 0 | 0 |
| S (tuned) | 45/45 | 0 | 0 |
| S (brief) | 45/45 | 0 | 0 |

Runtime and memory:
- First run: 1.7–5.4 s in Node (B: 2.5–5.6 s), including ~0.6 s saved in calibration. The sweep itself costs about as much as the old greedy fit plus group comparisons.
- Slider re-runs: 23–94 ms (B: 30–162 ms). They only re-score, and nothing is ever refitted.
- Peak process RSS for a single-image run (node + sharp decoding the 24 MP JPEG): 802 MB on 1280 and 888 MB on 1294 (B: 815 / 931 MB). The detector's raster estimate is unchanged at 19–148 MB. The tables hold ≤ 3 configurations per K per unit, about 2,000–3,000 configurations per plate, i.e. well under 1 MB.

### S.4 What the overlays show (zoomed crowded regions, B vs S vs Sb)

- **1280 (cream, touching chains).** S and B place nearly the same circles. Where B had a 3-way review triple, S decides it, and one dim colony is caught only after the recall rule (S.2 item 5). A chain of three colonies near (2125–2160, 1350–1420) is explained as two circles by S, one of them enlarged to cover the third lobe; B had three. Under the tuned objective K = 3 loses by 0.07 colony units, mostly to the overlap term (the three are ~40 % overlapped). This is the clearest remaining under-split I found. Sb shows several near-concentric double circles on single colonies.
- **1250 (hazy streak with dark seams between lobes).** S puts one circle on each seam-bounded lobe: 40 circles in a 700 px crop, against B's 31 larger circles, several of which span two lobes. S is visibly better here. Review dropped from 11 to 8 circles in that crop.
- **1294 (fluorescent carpet).** Inside the merged streak S and B are similar in density, and circles sit on the visible bright blobs. S has 6 % in review against B's 25 %. Units follow brightness seams, so circles no longer straddle cuts. A distance-only partition, tried first, produced visible near-duplicate pairs.
- **1268 (cream, scattered).** S ≈ B. Both miss a few pale, lighter-cream colonies in the crop around (3500–4200, 875–1575). Sb finds some of them but also puts double circles on single colonies (5 in one crop) and has 4× the review regions.

### S.5 Default: `tuned`, with the sweep

- `tuned` with the sweep keeps the count of B (+36 over 21 plates), decides more (review 3–14 %, against 5–33 % for B and 9–46 % for Sb), passes all 45 fixtures and is deterministic.
- `brief` with the sweep adds 423 suggestions (+9 %). By eye, many of these are second circles on single colonies; some are genuinely missed pale colonies. It is also the variant with a false positive on the empty plate 1283.
- The owner prefers recall, but duplicates on single colonies are the failure to avoid, and `brief` still has no overlap term to prevent them. The recall gains `brief` offers are better obtained with the sensitivity slider, which in S only re-scores.

### S.6 Remaining failure modes (no GT)

- **Deeply overlapped chains (≥ 40 %)** can still be explained with one enlarged disk too few: the overlap term ω penalises the correct explanation (S.4, 1280).
- **Pale or dim colonies** unlike the seeds are sometimes left out (1268). The recall rule only fires when the empty choice is nearly tied.
- **Review regions are larger**: up to 10 colonies (B: ≤ 7), because a unit is a seam-bounded group of up to 6 typical colonies and the alternative is a whole-unit K. Fewer regions in total.
- **Units are independent.** A colony cut by a geometric k-means split (units > 10 colonies) could be counted twice or not at all. That case is rare on these plates (largest unit swept K_max = 14).
- **Hazy plates 1249/1250** remain the most ambiguous. 1249 has 2 strict under-split suspects.

### S.7 What ground truth is needed

- Fully annotated crops of **merged streaks** (1250, 1293/1294) and **touching chains on cream plates** (1280, 1290), about 300–500 colonies, with colony centres. With them we can tune ω, λ and the review stability width on a development split and measure per-cluster count error by cluster size.
- A few plates with **pale or second-morphology colonies** (1268), to decide whether the appearance bound should widen.
- **Repeat annotations of one plate by two people**, to know how much disagreement in streaks is irreducible. That sets the target review share.
- The harness is ready: `npm run eval -- --gt project.zip --seeds gt:5 --resample 10`.

> **Section 0 describes the retune after field feedback (same day, second phase) and supersedes conflicting statements in §1–§8.** Those sections describe the first version, which is the one deployed when the feedback came in.

## 0. Retune after field feedback

Field reports:
- **Product owner, iPad**: "a cluster of 3 just became a single one"; later, "the current automated analysis undercounts by quite a lot".
- **Integration agent**: about 70 % of suggestions on cream plates landed in review regions, whole streaks became one "12 or 13?" region, and slider re-runs took the full ~4 s.

No ground truth arrived; numbers are counts, review shares and runtimes on the same 21 plates and agent-picked seeds as §4.

### 0.1 What was wrong

| Symptom | Cause (found on the plates and in fixtures) |
| --- | --- |
| Compact clusters merged ("3 → 1") | A **greedy local minimum**: the first greedy step takes one big disk over a compact triple; the split move only tries two disks, which cannot cover a triangle. Three prior-sized disks scored better by > 1 colony unit but were never reached. Reproduced exactly by a synthetic triangle at 30 % overlap (K = 1). Watershed merged compact triangles and squares because they have a single distance-transform peak. |
| Undercount (missed colonies) | (1) Groups the greedy left empty **never tried K = 1**: a "clear single" shortcut capped the sweep at K = k₀ = 0 (22 groups on 1290 alone, up to 1.6 colony areas each). (2) The soft mask membership was relative to the *seeds'* brightness, so a colony at ~50 % of the seed contrast gained nothing from being covered. (3) A first disk paid the full edge cost for its boundary inside not-yet-explained foreground. (4) Disk pixels on the rim cost as much as explained pixels. (5) The size prior priced out colonies smaller than the (large, isolated) seeds. (6) Count penalty and mask threshold were set for precision. |
| Review everywhere, whole streaks one region | The review UI marks a whole cluster as a review region if *any* of its suggestions is `review`; clusters were connected components, i.e. whole streaks. The raw objective gap scales with colony size (small colonies always "ambiguous"), and "colony or no colony" (K = 0 runner-up) was treated like "2 or 3?". |
| Slider re-runs ≈ full run | The worker's decode cache held one image, so pass 1 evicted the final image and every re-run decoded twice and recalibrated; the mask and all fits depended on sensitivity, so nothing could be reused. |
| iPad resolution | A 4 MP default cap (and a proposed 2.5 MP iPad cap) can push colonies below the ~8 px radius needed to see the seams between touching colonies. |

### 0.2 What changed (`src/detection/`)

- **Groups (sub-clusters) and a per-group K sweep** *(superseded by §S: units along seams, a full K sweep per unit, no greedy fit)*. After the greedy fit, disks joined by a wide neck (≥ 0.7 r at the narrowest point) form groups of ≤ 3 disks. Each group compares K = k₀−1 … max(k₀, area estimate)+1, each K initialised by farthest-point + k-means on the group's pixels and jointly refined. Groups are what the UI sees as clusters (`clusterId`, `bbox`, `chosenK`, `runnerUpK`, `alternative`), so review regions are local.
- **Soft, intensity-aware mask term**, relative to the cluster's own brightness: uncovered pixels cost their membership m, covered pixels cost 1 − m, so the 1–2 px seams between touching colonies argue against a disk spanning them, and dim colonies count fully.
- **Recall bias** (product decision: a false suggestion costs one tap, a missed colony a hand count):
  - FP weight 0.5;
  - boundary inside foreground at 0.25 weight;
  - size prior with oversize ×2 and undersize ×0.5;
  - λ 0.1 and mask threshold 0.35 × seed contrast at the default sensitivity.
- **Review on the relative gap** *(superseded by §S.2 item 4: review is now K instability; reviewGap is off by default)*: objective gap per contested colony (colonies that differ between the best and the runner-up explanation), threshold 0.03; a K = 0 runner-up never makes a review region (tap-to-reject handles it). Alternatives also carry `added` circles and `removed` primary indices (centres within 0.5·r, radii within ±35 %); the full set is kept.
- **Re-runs re-score instead of refitting**:
  - `DetectorCache` keeps the prepared image, the calibration (keyed by the seeds) and per-group configuration tables (K, disks, objective without count and prior terms).
  - A sensitivity (λ) or size-tolerance (s) change re-scores the stored configurations. *(Superseded by §S: tables are complete and read-only; the edge extension, which made results history-dependent, is gone.)*
  - Mask and candidates no longer depend on sensitivity.
  - Cache keys include the image fingerprint (new optional `imageFingerprint` input).
- **Worker**:
  - It memoises the analysis plan per image + seeds (re-runs skip pass 1) and keeps bounded LRU caches.
  - Each reference image is decoded once per run.
  - Cancellation is checked between decodes, and a transferred `ImageBitmap` is closed.
  - Errors are typed (`DecodeError` → `decode-failed`, `RangeError` → `out-of-memory`).
  - The client rejects pending work when the worker fails to load, crashes or sends an unreadable reply, and restarts it from the factory; `detect()` after `dispose()` rejects.
- **Analysis resolution (product decision: best resolution, no iPad cap)**:
  - No default pixel cap.
  - The worker decodes only the plate (ROI bounding box + 4 %) at the scale that gives a typical colony 8 px (smallest expected ≥ 4 px). That keeps the image at 0.6–2.8 MP here.
  - The fitter computes LoG candidates per cluster patch instead of holding a whole-image LoG stack.
  - The effective scale, crop, typical radius and plan note are recorded in `run.diagnostics.analysis`. `analysis.maxPixels` remains an explicit override.
- **Review findings folded in**: the patch from `/tmp/cfu-review` could not be applied directly (the permission system blocked applying an external patch); its fixes were re-implemented by hand. These cover the client lifecycle, bitmap close, cancel during reference crops, no `Math.max(...spread)` on candidate lists, and preparing the image once. On top: review clusters are reconciled after suggestion filtering, so "k or k+1?" counts what the user sees, and the ROI never crashes on a degenerate outline.
- **Watershed** also takes markers from the core mask (compact triangles and squares now split).
- **Regression fixtures** (`clusters.test.ts`): pairs, chains of 3/4, triangle and square at 0/15/30/40 % overlap, end to end through `detect()` for both objectives; a clear triple must be K = 3 with a relative gap ≥ 5× the review threshold; watershed must split the 15 % cases; a single colony stays one.

### 0.3 Objective: the brief's formula vs the tuned objective

`settings.objective`:
- `'brief'` is exactly the product owner's formula: L_mask(M, M̂) + α L_boundary + β Σ((log r − μ)/s)² + λ K, with γ = ω = 0. The boundary term hides edges inside other disks; β applies to ½z² as in the tuned variant.
- `'tuned'` (default) uses an area-proportional count λ Σ(r/r̃)², an asymmetric Huber prior (oversize ×2, undersize ×0.5), the appearance term γ and the overlap term ω.

Both use the same mask, candidates, groups, K sweep and recall settings.

| | tuned (default) | brief |
| --- | --- | --- |
| Synthetic clusters of 2–4, 0–40 % overlap | all correct; clear cases (≤ 15 %) decided | all counts correct; clear chain of 4 at 15 % sent to review |
| Total suggestions, 21 plates | 4,709 | 5,093 |
| Review share, cream plates | 5–13 % | 17–32 % |
| Empty plates 1283–1285 | 0 / 0 / 0 | 0 / 0 / 3 (1285 all in review) |
| What the extra brief suggestions are | – | mostly a second, overlapping circle on a single colony (35–46 per cream plate, e.g. 1268, 1282); some genuinely missed small colonies |

On the question "does λ·K plus a quadratic prior fix under-splitting?": with the per-group K sweep, both variants split the fixtures and the "3 → 1" case. The under-splitting came from the search (greedy local minimum), not from the count shape. λ·K does over-split: without the overlap term, a second disk half-covering a colony is cheap.

**Recommendation: keep `tuned` as the default.** The brief variant stays selectable for comparison and for evaluation once GT exists. Why each extra term is kept:
- **Overlap ω**: real colonies rarely overlap deeply; without it, single colonies get two overlapping circles (the brief variant's main failure above).
- **Appearance γ**: penalises disks dimmer than the seeds' lower bound and ring-shaped profiles. On these plates it is what keeps bubbles (dark centre, bright rim) out: of 6 large K = 0 groups inspected after the retune, 4 were bubbles.
- **Area-proportional count**: λ should mean "a colony must explain this fraction of its own area"; a flat λ·K prices small colonies out (small disks explain little area) and makes duplicates as cheap as real colonies.
- **Asymmetric prior**: oversized disks are the signature of merged colonies (the reported failure); undersized ones are common because users pick large, obvious colonies as seeds (brief §2 warns about this bias).

Circles only; nothing here justified ellipses.

### 0.4 Before / after, per plate

"Deployed" = the version before this retune with its defaults (the `before` run); "new" = current defaults. Counts are new suggestions (excluding the 7–8 seeds). Review = share of suggestions inside review regions under the UI's rule (number of regions, largest region in colonies). Node 26, Apple M3 Max; both runs go through the same decode path except that "new" uses the plate crop.

| plate | deployed | new | Δ | review deployed | review new | first run ms | slider re-run ms | r̃ px / scale |
|---|---|---|---|---|---|---|---|---|
| 1249 (hazy) | 140 | 187 | +47 (+34 %) | 93 % (6, 66) | 32 % (19, 5) | 1546 → 3522 | 1144 → 32 | 8.0 / 0.183 |
| 1250 (hazy) | 86 | 142 | +56 (+65 %) | 93 % (6, 40) | 33 % (14, 6) | 1183 → 3177 | 1121 → 61 | 8.9 / 0.159 |
| 1268 | 213 | 260 | +47 (+22 %) | 69 % (64, 13) | 5 % (7, 3) | 3496 → 3427 | 3260 → 56 | 8.0 / 0.310 |
| 1269 | 221 | 266 | +45 (+20 %) | 57 % (46, 16) | 5 % (7, 3) | 3560 → 3488 | 3252 → 54 | 8.0 / 0.312 |
| 1278 | 224 | 252 | +28 (+12 %) | 46 % (25, 15) | 13 % (12, 4) | 3309 → 3594 | 3091 → 67 | 8.0 / 0.342 |
| 1279 | 226 | 257 | +31 (+14 %) | 63 % (32, 16) | 6 % (6, 5) | 3383 → 3532 | 3167 → 60 | 8.0 / 0.327 |
| 1280 | 205 | 241 | +36 (+18 %) | 75 % (26, 25) | 12 % (11, 4) | 2008 → 3352 | 1854 → 49 | 8.0 / 0.277 |
| 1281 (1 colony) | 1 | 1 | 0 | 0 % | 0 % | 1802 → 2676 | 1671 → 44 | 8.0 / 0.280 |
| 1282 | 233 | 283 | +50 (+21 %) | 76 % (52, 21) | 8 % (9, 4) | 2282 → 3562 | 2077 → 51 | 8.0 / 0.285 |
| 1283 (empty) | 0 | 0 | 0 | 0 % | 0 % | 1811 → 2812 | 1648 → 46 | 8.0 / 0.280 |
| 1284 (empty) | 0 | 0 | 0 | 0 % | 0 % | 1779 → 2832 | 1647 → 43 | 8.0 / 0.280 |
| 1285 (empty) | 0 | 0 | 0 | 0 % | 0 % | 1815 → 2636 | 1689 → 46 | 8.0 / 0.280 |
| 1287 | 141 | 164 | +23 (+16 %) | 61 % (36, 8) | 7 % (7, 3) | 2052 → 3006 | 1908 → 49 | 8.0 / 0.286 |
| 1290 | 212 | 274 | +62 (+29 %) | 74 % (56, 23) | 8 % (12, 3) | 3702 → 3527 | 3469 → 59 | 8.0 / 0.304 |
| 1291 | 195 | 253 | +58 (+30 %) | 63 % (48, 11) | 5 % (8, 4) | 3562 → 3409 | 3422 → 50 | 8.0 / 0.305 |
| 1292 (fluor.) | 286 | 350 | +64 (+22 %) | 99 % (3, 275) | 20 % (27, 5) | 4435 → 5111 | 4385 → 96 | 8.0 / 0.405 |
| 1293 (fluor.) | 333 | 388 | +55 (+17 %) | 98 % (10, 305) | 26 % (35, 5) | 4489 → 5442 | 4356 → 146 | 8.0 / 0.424 |
| 1294 (fluor.) | 315 | 410 | +95 (+30 %) | 94 % (6, 283) | 25 % (34, 5) | 4811 → 5806 | 4608 → 169 | 8.0 / 0.407 |
| 1295 (fluor.) | 220 | 275 | +55 (+25 %) | 87 % (17, 138) | 20 % (21, 6) | 4264 → 4719 | 4203 → 117 | 8.0 / 0.407 |
| 1296 (fluor.) | 320 | 408 | +88 (+28 %) | 93 % (11, 261) | 30 % (42, 6) | 4481 → 5216 | 4337 → 118 | 8.0 / 0.406 |
| 1297 (fluor.) | 228 | 298 | +70 (+31 %) | 95 % (11, 99) | 27 % (26, 5) | 4318 → 4904 | 4147 → 123 | 8.0 / 0.407 |
| **total** | **3,799** | **4,709** | **+910 (+24 %)** | | | | | |

- On the cream plates the new fitter now counts as many as watershed and LoG (new W/A on 1268: 273/262, 1290: 304/297) instead of 10–30 % fewer. On fluorescent plates it is above both, as before.
- Review regions are local everywhere: largest 3–6 colonies, against 66–305 before. Cream plates are at 5–13 % (target < 10 % met on 7 of the 9 cream plates with colonies; 1278 at 13 %, 1280 at 12 %). On capture001280 that is 11 regions of ≤ 4 colonies. The integration agent's 24 → 13 was measured with an intermediate uncommitted build.
- Slider re-runs: 32–169 ms in Node (target < 1 s). The first run is somewhat slower (K sweeps; the "new" first run includes the preliminary pass, which the deployed column measured separately as ~3 s, see §4.3). iPad projection: about 1.5–2.5× Node, i.e. first run ~5–15 s on the fluorescent plates, re-runs well under 1 s. Not measured on hardware.
- Memory: estimated peak raster footprint 19–148 MB (was up to 288 MB): the plate crop and per-cluster LoG.

### 0.5 Remaining failure modes (no GT yet)

- **Hazy, merged streaks (1249/1250) and the fluorescent plates still have 20–33 % of suggestions in review.** These are mostly genuine 2-vs-3 ambiguities inside streaks (regions of ≤ 6 colonies). Seed bias (large isolated seeds, smaller streak colonies) still drives instability there (§4.2); marking 2–3 streak colonies as seeds should help, untested without GT.
- **Large, blurry colonies unlike the seeds** can still be split into several disks (fluorescent plates).
- A few **small, dim colonies** remain missed when K = 0 wins narrowly; at higher sensitivity they appear.
- **Bubbles** next to the size prior can now be suggested (recall bias); the reviewer rejects them with a tap.
- **History dependence** *(fixed in §S)*: a group's table grows when a re-run extends it, so returning to a previous slider value can give a slightly different count (1293: 388 → 399 at the same settings after exploring). Benign, since extensions only add explanations, but a reload resets it.
- **Weights are still tuned by eye** on a handful of plates and must be re-fixed on a development split once annotated zips arrive (`npm run eval -- --gt project.zip --seeds gt:5`). The product owner has been asked for zips of failing plates; none had arrived when this was written.


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

`chooseAnalysisScale` picks max(4/r_min, 8/r̃) analysis px per original px, where r_min = exp(μ − 2s) and r̃ = exp(μ). (Superseded: no default cap any more, and the worker analyses only the plate crop, see §0.2.) Without a prior it uses a 2048 px long side. The original plan, "smallest colony ≥ 3–4 px", gave r̃ ≈ 6 px on these plates. At that size the core mask covered whole merged groups and the fitter could not separate touching pairs. At r̃ = 8–10 px the seams appear.

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

## 7.1 As built (2026-10-09)

Implemented in `src/state/assist/` and `src/ui/assist/`, mostly as proposed below. Differences:

- **Entry point**: "Find similar" is a separated trailing toolbar item after Redo (in the More popover on narrow widths), shortcut **F**. It stays clickable when unavailable; the panel names the reason (no image, no group, locked/hidden group, image changed, decoded size mismatch, no examples) and offers the fix.
- **Seeds**: the active group's manual annotations on this image. With fewer than 3, the panel offers images of the project with ≥ 3 manual examples in the same group (reference plate); local examples are sent too.
- **Layer lifetime**: kept per image in memory while the project is open (not dropped on image switch, so switching back shows it again). Suggestions are drawn and tappable only while the review panel is open.
- **Pending state is derived** from the current annotations, so manual marks added after the run hide the suggestion under them and undo of an accept brings suggestions back. Each accept gets its own run id.
- **Review regions**: navigated with previous/next, which pans/zooms the viewport (`showRect`). The runner-up colonies of the selected region are drawn dotted. Regions with nothing new but an alternative read "One more?".
- **Not built**: lasso accept, user-drawn ROI, drawing the analysed outline, seed rings.

Browser runtimes (headless Chrome 2026, Apple M3 Max, 6016×4016 JPEG, wall clock from the click including blob read and decode in the worker; detector time from `timingsMs.total`):

| plate | seeds | method | wall | detector | suggestions |
|---|---|---|---|---|---|
| 1280 | 6 local | fitter | 3.9 s | — | 202 (141 in 24 review regions) |
| 1280 | 8 local + 99 accepted fixed | fitter | 3.7 s | 2.0 s | 111 |
| 1280 | 8 local | blob / watershed | 4.9 s / 2.6 s | — | 130 / 91 |
| 1281 | 8 from 1280 (cross-plate) | fitter | 4.7 s | 1.8 s | 1 |
| 1250 | 8 from 1280 (cross-plate) | fitter | 5.8 s | 2.8 s | 361 (streaks as "153 or 154?" regions) |

A slider change re-runs in about the same time as the first run (≈ 4 s incl. the 450 ms debounce): the fit dominates, so the plane cache saves little. The review-flag rate observed in §4.1 is visible in the UI: on cream plates most suggestions sit in review regions, and whole streaks become one region. That needs GT-based tuning of `reviewGap` before "Accept all OK" is useful on crowded plates. No real iPad was tested.

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

## Reference counts from the product owner (2026-10-09)

Manual counts reported by the product owner for checking the detector. These are approximate region totals, not per-colony ground truth. Regions are described loosely; the region tool's "Compare with detector" will make them precise once the manual marks are in a project.

| Image | Region | Manual count | Notes |
|---|---|---|---|
| capture001250 | upper-left streak/area | 136 | counted manually |
| capture001247 | upper-left streak (x 1960–2980, y 500–1900) | ~170 | in `test_images/` since §SC; see §SC.4 |

## Region tool: Find similar in region and "Compare with detector" (2026-10-09)

The Region tool (see `docs/architecture.md`, "Region selection") restricts a run to a
drawn polygon (`DetectionRun.roi = {kind:'polygon', points}`) and adds a ground-truth
check that turns the owner's manual counts into measurements:

1. Mark the colonies of a region by hand (or open a project where they are marked).
2. Draw a region around them (Region tool, R) and press **Compare**.
3. The detector runs on the region **without** those marks as fixed colonies. Examples:
   either up to 8 spread-out marks from the region (farthest-point sampling; at most
   half of the marks), or, when at least 3 exist, the group's manual marks outside the
   region. Examples are fixed colonies and are never scored (as in `scripts/eval`).
   Automated marks of the group inside the region stay fixed and are not scored.
4. Detector suggestions (near-duplicates removed, the detector's chosen option in
   review regions) are matched one-to-one to the scored marks within the typical colony
   radius (the seed prior's r_median): `matchPoints` from `src/detection/match.ts`,
   the same function and the d = 1.0 × r_typical radius as `gtMetrics` in
   `scripts/eval/run.ts`.
5. The bar shows manual / detected / matched / missed / extra with recall and
   precision; missed marks get an orange ring, extra detections a dashed cyan ring.
   **Export comparison** writes `<image>-region-comparison.json`
   (`kind: "cfu-count/region-comparison"`, version 1): region polygon and bbox,
   examples, detector method/version/settings/calibration, counts, and every missed,
   extra and matched position. Nothing in this workflow changes annotations.

Please send exported comparisons with the plate name; with several of them the tuning
in §S can be checked against real per-colony counts instead of agreement between
methods.

### First run on capture001250 (headless Chrome, commit df0a749)

- Region: a 10-point lasso around the upper-left streak, bbox x 2120–3060, y 420–1960
  (940 × 1540 px), the area the owner counted (136 colonies).
- **Find similar in region**, examples = the 7 agent seeds (all outside the region, on
  the large isolated colonies of the lower half): **66 suggestions** (6 in one
  "6 or 7?" review region) vs the owner's **136**, in 2.6 s including decode. This is
  the seed-size bias described in §4.2/§S: the seeds have r ≈ 49 px, the streak
  colonies are smaller, so several streak colonies get one circle.
- **Compare** could not use the owner's marks (they are not in a project yet). As a
  pipeline check the region was "marked" by script with 74 synthetic marks (detector
  centres ±6 px), so these numbers are NOT an accuracy: 8 examples from the region,
  66 scored, 102 detected, 66 matched, 0 missed, 36 extra (match radius 40.8 px).
  With examples taken from the streak itself the detector proposed more, smaller
  circles than the reference set, which is the direction the owner's 136 points to.
- capture001247 (~170 in the upper left) was not run.
