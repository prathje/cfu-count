# Assisted CFU counting in the browser: options and recommendation

Status: research note, 2026-10-09. Nothing here has been prototyped or benchmarked in this repo yet. Claims about third-party tools are cited. Performance numbers marked *estimate* are my own reasoning and need a benchmark.

Context: brief §9 (assisted counting is a later phase: the user marks representative colonies, picks a region, asks for "find similar", reviews suggestions, and accepts a batch as one undo step) and `src/model/types.ts` (`Annotation.origin`, `reviewStatus`, `DetectorProvenance`). Hard constraint: everything runs in the browser on static hosting (GitHub Pages), with iPad Safari as a first-class target.

Revision 2 (same day): integrates the product owner's method brief `colony-fitting-method-brief.md` ("the method brief" below). That brief proposes seed-derived per-group size/appearance priors plus a constrained union-of-circles fit. It is assessed in §3.4. The table, recommendation, phases (§6.1), interface (§6.2), type mapping (§6.3), evaluation (§5) and risks (§6.6) are updated to match it.

---

## 1. Summary of options

| # | Option | What it does | Pros | Cons | Effort | Added download | Verdict |
|---|---|---|---|---|---|---|---|
| S | **Seed calibration** (method brief §1–2) | From the group's manual marks: estimate each seed's radius from the image, flag low-quality seeds (touching, edge, glare), fit a robust log-normal radius prior (median / scaled MAD, floor s_min) and per-feature appearance ranges | Needed by every option below. Shows the user what was learned ("8 manual examples; 6 usable"). Cheap | Radius estimation from a point is the single biggest error source. Seeds are biased toward large, easy colonies | ~1 week | own code | **Phase 1a, shared foundation** |
| H | **Seed-constrained union-of-circles fitter** (method brief §3–5) | Local foreground mask, then connected clusters. For each cluster, compare K = 1…K_max disks from distance-transform peaks and contour-arc circle fits. Objective: mask + edge + size-prior + appearance + count penalty. Manual centres are fixed disks. Close alternatives are flagged for review | Directly addresses touching clusters. Gives centres **and** radii. Explicit ambiguity flags instead of forced counts. MCount is a published precedent for the candidate/selection idea | Depends on a decent foreground mask. Five loss weights to tune, and the count penalty needs reviewed crowded examples. More code than A. The seed-prior adaptation is unvalidated | 3–5 weeks incl. tuning | own code (~tens of KB) | **Phase 1b, primary detector** (per the product owner), validated against a watershed baseline |
| A | **Classical exemplar-tuned blob detector** (LoG/DoG) | Multi-scale LoG/DoG peaks at seed-derived scales, scored against seed colour/contrast/profile, with the threshold calibrated so the seeds are recovered | Small, fast, needs no mask, separates round touching pairs | Weak on irregular colonies and big clusters. Gives no cluster-level ambiguity | 1–2 weeks | ~10–30 KB | **Candidate generator / fallback** inside H, and a comparison baseline |
| W | Threshold + connected components + distance-transform watershed | Classical segmentation split | Simple. The method brief §7 requires it as the baseline | Over- and under-splits. No size prior | ~1 week (shares S/H primitives) | own code | **Required baseline** in the harness |
| B | S/H/A/W primitives on **OpenCV.js** | `HoughCircles`, `adaptiveThreshold`, `distanceTransform`, `watershed`, `matchTemplate`, etc. are ready-made | Mature, battle-tested primitives; fast prototyping | Official 4.13 `opencv.js` is **10.96 MB raw / 3.5 MB gzip** (measured), and the WASM is embedded as base64. Emscripten memory management (`Mat.delete()`) | Days to prototype | 3.5 MB gz (lazy) | Good for a **throwaway prototype**. Optional for production |
| C | **image-js** (MIT, pure JS/TS) | General image library | MIT, TS, no WASM | Unpacked npm 11.7 MB (tree-shaking untested). Feature coverage for watershed/LoG not verified | Days | unknown, likely 100s of KB | Possible source of primitives. Check before adopting |
| D | **Interactive learned pixel/patch classifier** (ilastik / Arteta-style) | Per-pixel filter-bank features at a few scales, trained from the user's dots plus background samples plus rejected suggestions. Small logistic regression / random forest / ridge density regressor, retrained in the Worker | Adapts to each plate's look. Rejections improve the model (active learning). Handles colour/morphology variation better than fixed rules | More UI (negatives, retrain loop). Feature stacks are memory-heavy at full resolution. Calibration is still per-plate | 2–4 weeks on top of S/H | ~50–100 KB (e.g. `ml-random-forest` 61 KB unpacked) | **Phase 2**: improves H's foreground mask and appearance term |
| E | **Pretrained colony detector** (excluded from the mainline by the method brief: "no pretrained network") (YOLO-n trained on AGAR / Makrai dataset) exported to ONNX, run with ONNX Runtime Web | Detection boxes with scores, tiled (SAHI-style) | Can be accurate on images that look like the training data (published mAP@0.5 ≈ 0.97 on in-domain data) | Domain shift to your plates/phones is unproven. **Licences**: Ultralytics is AGPL-3.0, AGAR data is CC BY-NC 2.0. Needs ORT Web (`ort-wasm-simd-threaded.wasm` alone is 14.2 MB raw) plus a model of ~5–10 MB. Threads need cross-origin isolation, which GitHub Pages cannot set natively | 3–6 weeks + training infra | ~15–25 MB | Phase 3, **experimental** |
| F | **Exemplar-based class-agnostic counters** (FamNet, CounTR, LOCA/DAVE, GeCo/GeCo2) | "Count things like these boxes" | Exactly the right interaction model in principle | GPU research models with ResNet-50/ViT/SAM backbones and ~1024–1536 px inputs. I found no official ONNX/web ports. Exemplars must be **boxes**, not points. Unknown accuracy on tiny dense colonies | Research project | 100s of MB | **Not feasible now**. Revisit |
| G | **SAM-family promptable segmentation** (SlimSAM in Transformers.js) | Click a point and get a mask | Could turn an exemplar *point* into a radius/mask. SlimSAM-77 is reported at ~14 MB INT8 on WASM | Not a counter; running it per candidate is too slow. Bigger SAM 2.1 variants are 145–878 MB | ~1 week to try | ~14 MB + runtime | Optional helper for exemplar radius later |

**Recommendation (revised).** Adopt the method brief's design as the mainline. It agrees with this note on everything essential: seeds from the user's own marks, priors per group and image, points estimated from image evidence, suggestions kept separate, no server and no pretrained network. It goes further than the original plan on touching clusters.

1. **Phase 0**: evaluation harness on project exports. It must include the brief's metrics (missed, duplicate, centre error, per-cluster count error, seed-selection sensitivity, runtime and memory).
2. **Phase 1a**: seed calibration **S**, plus the watershed baseline **W**.
3. **Phase 1b**: union-of-circles fitter **H**, with LoG (**A**) as an extra candidate source and a fallback for isolated small colonies where the mask is weak. Ship only if the harness shows H beats W on touching clusters without losing on isolated colonies.
4. **Phase 2**: **D**, mainly to produce a better foreground mask and appearance term for H.
5. **E/F/G**: optional research spikes only.

All of it runs as pure TS in one cancellable Worker. Use OpenCV.js (**B**) only for throwaway prototyping. Persist nothing automated until accepted. The brief's requirement to save run records and inferred geometry needs a schema addition (§6.3).

---

## 2. Classical pipeline building blocks

All of these map to well-known operations. The papers below show that classical pipelines reach roughly human-level counts on clean plates.

### 2.1 Plate / ROI detection
- **Hough circle transform** finds the dish rim. In OpenCV it is `HoughCircles` with the `HOUGH_GRADIENT` method; it needs a radius range (from image size: the plate is usually 60–95 % of the short side). Run it on a heavily downsampled image (~800 px). Phone photos taken at an angle make the rim an ellipse, so Hough is a *suggestion* the user confirms or adjusts.
- **Simpler, more robust for this app:** let the user drag a circle ROI (the brief already wants "define a region to analyse"). Then erode the ROI by a margin (a few % of the radius) to exclude the rim, where reflections and the meniscus produce false positives. Report the excluded band so the user can mark edge colonies manually.
- Edge handling in published tools: OpenCFU explicitly reports robustness to edges, bubbles and dust as a selling point ([Geissmann 2013, PLOS ONE](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0054072)). That robustness came from shape filters, not from rim detection alone.

### 2.2 Background / illumination correction
- **Morphological top-hat / rolling ball.** White top-hat (image minus opening) with a structuring element larger than the largest colony removes slow illumination gradients. ImageJ's "Subtract Background" is the rolling-ball variant. Use black top-hat for dark colonies on a light agar.
- **Large-kernel median or Gaussian background estimate**, subtracted or divided. OpenCFU does per-channel local median background estimation ([PLOS ONE](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0054072)).
- Fast implementations: a separable box/Gaussian blur at reduced scale. Grey-scale opening with a square or octagon structuring element via the van Herk/Gil-Werman running min/max (O(1) per pixel regardless of size).
- **Polarity and channel come from the exemplars.** Compare mean exemplar colour against an annulus around each exemplar. This tells you whether colonies are brighter or darker and which channel (or opponent colour axis) separates them best. This is cheap and replaces a fixed "grayscale" assumption.

### 2.3 Thresholding + connected components + watershed (segmentation route)
- **Otsu / adaptive (local mean or Gaussian) threshold**, then connected-component labelling with per-component area, perimeter, circularity, convexity, mean colour.
- **Touching colonies:** distance transform of the binary mask, then local maxima as markers, then watershed. This is the standard split, and it is what OpenCFU does for regions classified as "multiple objects" ([PLOS ONE](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0054072)). MCount ([Chen et al. 2025, PLOS ONE](https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0311242), [code, MIT](https://github.com/hyu-kim/mcount)) combines Otsu, contour concave-point detection and distance-transform circle fitting. It reports 3.99 % average error on 960 high-throughput images, versus NICE 16.5 %, AutoCellSeg 33.5 % and OpenCFU 50.3 % *on their dataset*. Those competitor figures come from a different imaging regime (small, low-resolution spots), so don't generalise them.
- **Multi-threshold scoring** (OpenCFU): instead of one threshold, sweep thresholds and accumulate a score map of pixels that form plausible circular objects. It is robust and conceptually simple, at roughly *k*× the cost.

### 2.4 Blob detection (detection route; candidate source for the fitter)
- **LoG / DoG / DoH**: scale-normalised Laplacian-of-Gaussian finds roughly circular blobs and returns a centre and a scale (radius ≈ √2·σ). scikit-image documents LoG as the most accurate and slowest, DoG as a faster approximation, and DoH as fastest but poor below ~3 px ([scikit-image blob example](https://scikit-image.org/docs/stable/auto_examples/features_detection/plot_blob.html)).
- Why this suits the app: the output is **points**, which is exactly the `Annotation` geometry. Touching *round* colonies give separate LoG maxima without any segmentation step. The sigma range can be set from the exemplars, so only 3–5 scales are needed.
- Non-maximum suppression in (x, y, σ) with a minimum separation of ~0.7× the smaller radius.

### 2.5 Template matching / normalised cross-correlation
- NCC (`matchTemplate` with `TM_CCOEFF_NORMED` in OpenCV) of an exemplar patch against the image gives a similarity map. With several exemplars, use the max or mean over templates. Colonies vary in size, so either match at a few scales or use a **rotation-invariant radial profile** (mean intensity in rings) as the descriptor instead of a raw patch.
- Brief §9 warns against "one fitted template for all plates". NCC is best used as one *scoring feature* on LoG candidates, not as the candidate generator.

### 2.6 Library choices
- **OpenCV.js**: the official build at `docs.opencv.org/4.13.0/opencv.js` measured **10,964,323 bytes raw, 3,542,509 bytes gzip -9** here. The WASM is inlined as base64, so it can't be streamed-compiled separately. The npm repackage `@techstark/opencv-js` 5.0.0 is Apache-2.0 and 14.7 MB unpacked. A custom Emscripten build with only `imgproc` can be much smaller (not measured). It works inside a Worker. Memory is manual (`mat.delete()`).
- **image-js** ([MIT, actively maintained](https://github.com/image-js/image-js)): 1.7.1 on npm. I did not verify which morphology/watershed/blob functions v1 exposes ([API docs](https://api.image-js.org/)). Check before relying on it.
- **Pure TS (recommended for production)**: the MVP needs perhaps eight primitives: separable Gaussian, box blur, running min/max (opening), Otsu, scale-normalised LoG/DoG, 3×3×3 NMS, connected-component labelling, Felzenszwalb distance transform, and optionally a priority-queue watershed. Each is 30–150 lines, unit-testable with vitest, tree-shakeable, with no WASM loading and no licence questions. *Estimate*: a separable Gaussian on a 4 MP `Float32Array` in modern JS engines takes tens of milliseconds, so a 5-scale DoG at 4 MP fits in a ~1 s budget on an iPad. Benchmark this.
- **Do not port GPL code.** OpenCFU is GPL-3.0 ([PLOS ONE](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0054072)) and the ImageJ Colony Counter plugin is GPL ([imagej.net](https://imagej.net/ij/plugins/colony-counter.html)). This repo currently declares no licence. Reimplement from the published method descriptions instead.

---

## 3. Example-driven detection ("find colonies like these")

### 3.1 What the user's marks give us, and what they don't
Marks are **points only** (`Annotation.x/y`). `AnnotationGroup.size` is a display size in screen px and explicitly *not* a colony radius (see `types.ts`). So the detector must **estimate each exemplar's radius from the image**:
- LoG scale selection at the exemplar: pick the σ maximising |∇²G_σ * I| at that point, within ±0.25 r of the click. This is cheap and robust for round colonies.
- Or a radial intensity profile: the radius is where the profile crosses halfway between centre and the annulus background.
- (Later) SlimSAM point-prompt mask, option G.

From k exemplars (k ≥ 3 recommended; warn at k < 3) derive:
- **Size range** [r_min, r_max] = exemplar radii widened by a user-adjustable factor (default ×0.6 … ×1.6).
- **Polarity and colour model**: mean and covariance of colony-centre colour (Lab or opponent space), and the colony-minus-local-background contrast. Score candidates by Mahalanobis distance (regularised; with k < 5, use a diagonal or shared covariance).
- **Local contrast**: the LoG response at the matched scale, normalised by local background noise (MAD in the annulus).
- **Shape/profile**: radial profile correlation with the exemplar mean profile (rotation- and size-normalised).
- **Threshold calibration**: set the score threshold so that leave-one-out exemplars are recovered (e.g. the lowest exemplar score × 0.8), then expose it as a slider. The user tunes one number, and the default is justified by their own marks.
- **Negatives for free**: pixels/candidates in the ROI far from any confirmed mark are *not* guaranteed background (the user may not have marked everything). Rejected suggestions *are* reliable negatives. Use them.

### 3.2 Learned per-pixel / per-patch classifier (Phase 2)
- **ilastik pixel classification** trains a **Random Forest** on colour/intensity, edge and texture filter responses at several Gaussian scales, from the user's brush strokes ([ilastik docs](https://www.ilastik.org/documentation/pixelclassification/pixelclassification)). ilastik's **density counting** workflow learns object density from dots and background strokes, and lets users refine interactively and watch counts in boxes ([ilastik paper](https://d-nb.info/1209741083/34)).
- **Interactive Object Counting** ([Arteta, Lempitsky, Noble, Zisserman, ECCV 2014](https://link.springer.com/chapter/10.1007/978-3-319-10578-9_33)) learns a density map from user dots with a fast linear model over per-pixel features, retrained interactively. It targets exactly the crowded/overlapping regime where detection fails. It builds on density counting from [Lempitsky & Zisserman, NeurIPS 2010](https://www.robots.ox.ac.uk/~vgg/publications/2010/Lempitsky10b/lempitsky10b.pdf) and on regression forests ([Fiaschi et al.](https://d-nb.info/1209741083/34)). Density integrates to a count but **does not give points**. For this app (point annotations, one per colony), density is useful as a *cluster count estimate* ("this blob is ~4 colonies"), not as the main output.
- **AutoCellSeg** ([Khan et al. 2018, Sci Rep](https://www.semanticscholar.org/paper/AutoCellSeg:-robust-automatic-colony-forming-unit-Khan-Torelli/4a8205ad11971f8c0c9684fa52ecd8e9e784b91c); [MATLAB code, MIT](https://github.com/AngeloTorelli/AutoCellSeg)) is "supervised" in a similar spirit. It uses multi-thresholding with a feedback-based watershed and plausibility criteria, plus post-editing.
- In-browser: compute ~10–20 feature planes at the analysis scale (e.g. 2 MP × 16 planes × 4 B ≈ 128 MB, which is too much on iPad). Compute features **only at candidate locations** (LoG peaks) or on tiles. A per-candidate classifier (logistic regression or a 50-tree random forest on ~20 features) trains in milliseconds. [`ml-random-forest`](https://www.npmjs.com/package/ml-random-forest) is MIT and 61 KB unpacked. This is the pragmatic version: **A generates candidates, D re-scores them**.

### 3.3 Exemplar-based class-agnostic counting models (checked)
| Model | Code / licence | Backbone & input (from paper/repo) | Exemplar form | Browser feasibility |
|---|---|---|---|---|
| FamNet "Learning To Count Everything", CVPR 2021 | [repo, MIT](https://github.com/cvlab-stonybrook/LearningToCountEverything); introduced FSC-147 (147 categories, >6000 images) ([arXiv](https://arxiv.org/abs/2104.08391)) | ResNet-50 features + density regressor, test-time adaptation | boxes | Density only (no points). Test-time adaptation needs backprop. No web port found |
| CounTR, BMVC 2022 | [repo, MIT](https://github.com/Verg-Avesta/CounTR) ([arXiv](https://arxiv.org/abs/2208.13721)) | MAE-pretrained ViT transformer | boxes | ViT-B-class model, density output. No web port found |
| DAVE, CVPR 2024 | [repo, MIT](https://github.com/jerpelhan/DAVE) ([paper](https://openaccess.thecvf.com/content/CVPR2024/html/Pelhan_DAVE_-_A_Detect-and-Verify_Paradigm_for_Low-Shot_Counting_CVPR_2024_paper.html)) | detect-and-verify on a LOCA-style density counter | boxes / zero-shot | Gives detections. Heavy. No web port found |
| GeCo, NeurIPS 2024 | [repo, MIT](https://github.com/jerpelhan/GeCo) ([arXiv](https://arxiv.org/html/2409.18686)) | **SAM backbone**, input scaled to 1024 or 1536 px. Authors list inference speed as future work | boxes | Detection + segmentation. SAM-backbone-sized download. Not realistic on iPad today |
| GeCo2, AAAI 2026 | [repo](https://github.com/jerpelhan/GECO2) (licence "NOASSERTION" on GitHub; check before use) | SAM2 + Deformable-DETR components; "3× faster, smaller GPU footprint" than GeCo | boxes | Still GPU-class. Hugging Face Gradio demo, i.e. server-side |
| Colony Grounded SAM2 (2026) | [arXiv 2603.13393](https://arxiv.org/abs/2603.13393); weights stated as open access | Grounding DINO + SAM2 fine-tuned on colonies, zero-shot, mAP 93.1 % reported | text / none | Two foundation models, far beyond browser budget |

Honest assessment: none of these has an official ONNX/Transformers.js port that I could find. All are trained and evaluated on natural-image benchmarks (FSC-147) or need GPU-class compute. All take **box** exemplars, while our marks are points. Feeding them would need the radius estimate from §3.1 anyway. ONNX export of research PyTorch code with custom ops (deformable attention, test-time adaptation) is often painful, and WebGPU operator coverage in ORT Web is a subset of WASM's ([ORT Web docs](https://onnxruntime.ai/docs/tutorials/web/)). **Unproven; do not plan on them.**

---

### 3.4 Assessment of the product owner's colony-fitting method brief

Source: `colony-fitting-method-brief.md` (repo root, 2026-10-09). It proposes: the user annotates a few colonies, presses Find similar in this group, reviews, accepts. Seeds give a robust per-group, per-image radius prior in log space (μ = median log r, s = max(s_min, 1.4826·MAD)) and soft appearance ranges. Clusters are fitted as a **union of disks** by minimising

J(K, θ) = L_mask(M, U_K) + α·L_edge(∂M, ∂U_K) + β·Σ ρ((log r_i − μ)/s) + γ·L_appearance + λ·K,

using candidates from distance-transform peaks and contour-arc circle fits. Manual centres are held fixed, and clusters where competing K fit similarly well are flagged for review. The brief itself says this is a proposal, not a validated detector, and not a published equation.

**Where it agrees with this note**
- Points carry location, not radius. The radius must be estimated from the image, and the display marker size is cosmetic (§3.1; `types.ts`).
- One model per annotation group. Don't pool heterogeneous exemplars. Use diagonal/robust appearance statistics with few seeds instead of a full covariance (§3.1).
- Background-normalised local contrast, and soft rather than hard size/colour limits.
- Runs in a cancellable Worker on a reduced-resolution analysis image, with no server and no pretrained network (§6.2, §6.5). This rules E/F out of the mainline, which matches my "not feasible / experimental" verdicts.
- Suggestions stay separate from confirmed counts. Accepting a batch is one undo step. Origin stays `automated` after accept or move. Scores are not calibrated probabilities, so use `confidence: null` (§6.3).
- MCount is the closest published precedent. The brief's pipeline is a seed-informed generalisation of MCount's contour-arc + distance-transform circle candidates + selection. MCount's selection is a 0–1 integer program, minimising contour–circle pairing distance plus λ × deviation from the candidate count, with d = 0.5 and λ = 38 tuned by grid search and 10-fold CV, at <1.7 s per sub-image ([Chen et al. 2025](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0311242)). The brief's second reference, ColTapp ([Bär et al. 2020, Sci Rep 10:16084](https://doi.org/10.1038/s41598-020-72979-4)), is a MATLAB tool using distance transforms, watershed and circular Hough detection. I did not verify its licence.

**Where it differs from, or changes, this note**
1. **Primary detector**: I had proposed LoG blob detection (A) as the MVP. The brief makes a mask-based cluster fitter (H) primary. I agree for touching clusters: LoG gives no principled per-cluster K and no ambiguity signal. But H depends on the foreground mask M, which is a single point of failure on phone photos (glare, condensation, colony-coloured media). So I keep LoG as an additional candidate source and as a fallback for small isolated colonies, and add the brief's required watershed baseline (W).
2. **Manual annotations as fixed disks**: I had proposed only radius-based de-duplication. The brief's version is better: manual centres (any group, including hidden) enter the cluster fit as fixed disks with their inferred radius. A cluster with one manual mark and three visible colonies then gets exactly two or three new suggestions, not four. Adopted in §6.2/§6.3.
3. **Ambiguity as a first-class output**: new. Results become per-cluster, with the chosen K, the runner-up K and the objective gap. Clusters with a small gap are flagged "review" rather than given a forced count. The review UX and interface change accordingly (§6.2, §6.4).
4. **Calibration threshold**: I had calibrated a score threshold so the seeds are recovered. The brief uses the prior inside the objective instead (β term) plus a count penalty λ. These are compatible. A sensitivity slider then maps to λ and/or a mask threshold rather than to a LoG score.
5. **No feedback of predictions into calibration**: the brief forbids silently adding predicted colonies to the seed set and keeps a fixed seed snapshot per run. My Phase 2 used *rejected* suggestions as negatives. That is a human label, not a prediction, so it is consistent with the brief, but it must be explicit and recorded in the run record. Accepted automated annotations must not become seeds unless the user opts in.
6. **Persisted run records and inferred geometry**: the brief asks to *save*, in per-image JSON, the inferred radius/boundary and quality per annotation, plus a run record (method/version, seed IDs, image identity/version, analysis scale, prior parameters, fitting settings, diagnostics). Schema v1 has no slot for either. I had left radius as "future schema". This makes the schema addition a requirement for adopting the brief (§6.3).
7. **Reference plate**: the brief scopes priors to "per annotation group and image" and says not to pool imaging conditions automatically. The original task framing mentioned an optional reference plate. Reusing seeds from another image is therefore an **open product question**, and should be an explicit, recorded choice if it is ever allowed.

**Browser/Worker feasibility of H** (*estimates, to benchmark*)
- All operations are local to a cluster patch. A cluster typically spans tens to a few hundred analysis pixels. Rasterising K ≤ ~8 disks into a patch of ≤ 200×200 px and evaluating mask/edge losses costs ~K × patch area operations per evaluation. Local refinement (coordinate descent or Nelder–Mead over 3K parameters, a few hundred evaluations) costs ~10⁷–10⁸ simple operations for a large cluster. In optimised TS typed-array code that is roughly tens of milliseconds per large cluster, and far less for singletons. A plate with a few hundred clusters, most of them K = 1, should fit within a few seconds in a Worker, with per-cluster progress and cancellation between clusters.
- Model selection over K: greedy add/remove from the candidate set plus local refinement, keeping the best and runner-up per K. An exact ILP as in MCount would need a WASM solver dependency. Start with greedy or beam search over small K, and consider an ILP only if the harness shows greedy failing.
- Edge term: needs a gradient-magnitude image at the analysis scale (one extra float plane) and the *exposed* boundary of U_K (arc pixels not inside another disk). This is cheap to compute on the patch raster.
- Large confluent regions: cap the patch size and K_max. Above the cap, return the region as "uncountable / review" rather than fitting it (brief §5).
- Memory: one RGB analysis image + background + mask + gradient + labels ≈ 5–6 planes. At ≤ 4 MP that is ≈ 100 MB, which is acceptable. Cluster patches are transient.
- Code: Otsu/adaptive threshold, CC labelling, distance transform, contour tracing, algebraic circle fit (Kåsa/Taubin) to arcs, disk rasterisation and a small optimiser. All pure TS and unit-testable. No new runtime dependency is needed.

**Open questions and risks specific to the brief**
- **Seed radius estimation quality** drives μ and s, and with them the whole fit. The brief rightly says to mark touching/edge/glare seeds as low quality. A minimum number of usable seeds is undefined ("no universally sufficient count"), so the UI needs a "tentative" state, and s_min must be set from measurement resolution (e.g. ≥ ~1 analysis px relative to r).
- **Weight tuning**: five terms (α, β, γ, λ, plus mask threshold and s_min), normalised across resolutions and cluster sizes. λ needs reviewed crowded clusters, which only exist once users have fully annotated some crowded plates. The harness corpus has to include those, and the weights must be fixed before any held-out evaluation.
- **Non-circular colonies** (spreading, swarming, irregular edges): the brief says circles first and bounded ellipticity only if needed. Expect H to over-split irregular colonies. A per-group "irregular" warning, from seed circularity, should lower trust.
- **Seed bias**: users mark large, obvious colonies, so the prior under-covers small ones. The brief asks to report poor coverage. The harness should test the case "seeds = the 5 largest colonies".
- **Seed-selection sensitivity** is a stated acceptance metric. It means repeated runs with resampled seeds in the harness (cheap offline).
- **Manual-centre constraints vs. inaccurate clicks**: a manual mark off-centre by a few px, fixed during fitting, can distort neighbouring fits. Option: fix the *existence* of a manual colony but allow its fitted disk centre to move within a small tolerance for loss computation only. The annotation itself is never moved.
- **Reproducibility**: a run record holding seed *IDs* alone can't reproduce a run once seeds are moved or deleted. Snapshot seed coordinates (and inferred radii) in the run record too.
- **Diagnostics are not confidence**: the objective gap and residuals belong in diagnostics, not in `DetectorProvenance.confidence`.


---

## 4. Existing tools and datasets

| Tool | Method | Licence | Notes |
|---|---|---|---|
| OpenCFU ([PLOS ONE 2013](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0054072)) | Per-channel median background, positive LoG, multi-threshold score map, shape filter, distance-transform watershed for multiples, optional colour-likelihood filter | GPL-3.0 | ~0.69 s for 1.6 × 1.6 MP. Median error 3 colonies on 10–1000-colony plates. Best blueprint for option A |
| NICE ([Clarke et al. 2010, Cytometry A](https://onlinelibrary.wiley.com/doi/10.1002/cyto.a.20864); [code](https://github.com/usnistgov/NICE-Public)) | Thresholding-based, dark colonies, multiple ROIs | US-Gov public domain | MATLAB 2016b. Repo archived June 2026. <3 % mean difference vs manual reported |
| AutoCellSeg ([Sci Rep 2018](https://www.semanticscholar.org/paper/AutoCellSeg:-robust-automatic-colony-forming-unit-Khan-Torelli/4a8205ad11971f8c0c9684fa52ecd8e9e784b91c)) | Multi-threshold + feedback watershed + post-editing | MIT ([repo](https://github.com/AngeloTorelli/AutoCellSeg)) | MATLAB GUI |
| MCount ([PLOS ONE 2025](https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0311242)) | Otsu + contours + concave points + circle fitting. Two hyper-parameters | MIT ([repo](https://github.com/hyu-kim/mcount)) | Good reference for splitting merged colonies |
| ImageJ Colony Counter ([imagej.net](https://imagej.net/ij/plugins/colony-counter.html)) | Threshold + particle analysis | GPL | Also: [CoCo macro](https://github.com/jiaxuanleong/coco) (no licence declared), Count-On-It (Fiji, commercial vendor) |
| YOLO colony detectors | e.g. YOLO11n (2.6 M params, 6.5 GFLOPs) on 640 px tiles with SAHI, mAP@0.5 96.9 %, <320 ms/plate on an RTX 3050 ([Sci Rep 2026, PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC13451340/); [code](https://github.com/sercankulcu/SAHI-Colony-Counting), no licence declared). Colony-YOLO (YOLOv8n variant, mobile deployment) ([Microorganisms 2025](https://doi.org/10.3390/microorganisms13071617)) | Ultralytics framework is **AGPL-3.0** ([repo](https://github.com/ultralytics/ultralytics)); SAHI is MIT ([repo](https://github.com/obss/sahi)) | Ultralytics exports ONNX directly, and nano models are a realistic ORT Web size. **AGPL obligations apply to the weights/code if distributed**; a permissively licensed detector (e.g. RT-DETR / YOLOX / own small CNN) avoids that |

| Dataset | Content | Licence | Use here |
|---|---|---|---|
| AGAR ([arXiv 2108.01234](https://arxiv.org/abs/2108.01234); [site](https://agar.neurosys.com/)) | 18,000 photos, 5 microorganisms, 336,442 colonies with boxes + species. Countable/uncountable/empty labels. Two cameras, controlled lighting | **CC BY-NC 2.0**, academic, registration required | Benchmarking. Training a shipped model on it constrains commercial use |
| Makrai et al. 2023 ([Sci Data](https://www.nature.com/articles/s41597-023-02404-8); [figshare 10.6084/m9.figshare.22022540.v3](https://doi.org/10.6084/m9.figshare.22022540.v3)) | 369 smartphone plate photos, 24 veterinary species, 56,865 boxes by two experts, deliberately unstandardised | Check figshare record (I did not confirm the licence) | **Closest to this app's input** (phone photos, varied backgrounds). Use for harness testing |
| [Microbial counting review list](https://github.com/majsylw/microbial-counting-review) | Index of datasets/papers (MicrobIA, DIBaS, etc.) | — | Discovery |

---

## 5. Evaluation using the user's own annotations

The app already produces the right ground truth: manual, point-level, per-image annotations with immutable `origin`. Project zip exports (images + `annotations/<imageId>.json`) can be the test corpus.

**Protocol**
1. Collect fully hand-counted plates (all colonies marked, `origin: 'manual'`). Record which plates are complete. A partially counted plate makes every unmarked true colony look like a false positive.
2. For each plate, pick k exemplars (k = 3, 5, 10; random and "user-like"), run the detector, and **exclude the exemplars from scoring**.
3. **Matching**: bipartite matching (Hungarian, or greedy by distance, which is fine at these densities) between predictions and ground truth within radius *d* = 0.5 × median exemplar diameter (report *d* = 0.3/0.5/1.0× as a sensitivity check). Report TP/FP/FN, precision, recall, F1.
4. **Count metrics**: absolute and relative count error, MAE across plates, and a Bland–Altman plot vs manual (the standard way colony-counter papers report agreement; OpenCFU and NICE both compare to human counts).
5. **Stratify** by density (e.g. <30, 30–300, >300 per plate, matching the common countable range), by radial position (inner vs outer 10 % of the ROI), by cluster membership (GT points with a neighbour within 1.2× diameter = "touching"), and by plate condition tags (uneven light, condensation, glare, mixed morphologies, coloured media). Add those tags to a harness-side sidecar file, not the app schema.
6. **Method-brief metrics** (brief §7): centre-location error of matched pairs (px and fraction of radius). Duplicates (two predictions matched to one GT, or a prediction near an existing manual mark). **Per-cluster count error**: assign GT points and predictions to the foreground connected components and compare counts per component, broken down by GT cluster size 1, 2, 3–5, >5. Rate and correctness of "review" flags: a flagged cluster is a deferral, not an error, but report how often flags fire and how often the chosen K was right anyway. **Seed-selection sensitivity**: rerun with ≥10 resampled seed sets per plate (random, "largest 5", "user-like") and report the spread of count and F1. Browser runtime and peak memory on a real iPad.
7. **Baselines**: report W (threshold + distance-transform watershed) and A (LoG) next to H on the same seeds. H is adopted only if it beats W on touching clusters without losing on isolated colonies. Fix all weights (α, β, γ, λ, s_min) on a development split before scoring a held-out split.
8. **Human-time metric**: the real goal is "time to a confirmed count". Log (locally) suggestions shown, accepted, rejected, and manual additions after accept. Acceptance rate × recall is what users feel.

**Known hard cases to test explicitly**
- **Touching/merged colonies**: LoG handles round touching pairs. Elongated merges need distance-transform watershed or concave-point splitting (MCount). Large confluent areas should be flagged "uncountable region", not guessed.
- **Plate edges**: rim reflections and meniscus give false positives. Erode the ROI and flag the band.
- **Uneven lighting / vignetting**: top-hat or background division before detection. Score contrast against the *local* annulus, never a global threshold.
- **Condensation droplets**: round and bright with specular highlights, so they look like colonies to LoG. Colour/texture features (droplets show the background through them, with a highlight off-centre) and user rejections are the main defence. Expect this to be the most common FP source on phone photos.
- **Mixed morphologies**: run one exemplar model per annotation group (the user marks exemplars in group "large white", others in "small yellow"), so each group gets its own size/colour model. Don't fit one model to heterogeneous exemplars. Warn when exemplars in one group are bimodal in size or colour.
- **Satellite colonies, writing on the lid, and agar scratches**: shape/contrast filters plus rejections.

---

## 6. Integration plan for this app

### 6.1 Phases
- **Phase 0 (now, alongside the manual MVP)**: keep a disabled, labelled "Find similar (coming later)" action (brief §9). Define the `Detector` interface and suggestion state (below). Write `scripts/eval` (node + vitest) that loads project exports and computes the §5 metrics, including per-cluster count error and seed sensitivity. Start collecting fully annotated plates, **including crowded ones**, because λ can't be tuned without them. Propose the schema additions in §6.3 to the schema owners.
- **Phase 1a, seed calibration + baseline (S, W)**: user selects a target group and presses "Find similar in this group". Existing manual annotations of that group inside the ROI are the seeds, so no separate calibration step is needed. Worker pipeline: decode at analysis scale, background flatten, per-seed radius estimate (local segmentation + radial edge evidence over several scales), quality flags (touching / edge / glare / weak edge), robust log-radius prior and diagonal appearance ranges. The UI shows the status ("8 manual examples; 6 usable for size estimation") and the inferred rings. Implement W on the same primitives so the harness has a baseline from day one. S is useful on its own as a visible check of what the detector "learned".
- **Phase 1b, union-of-circles fitter (H)**: foreground mask from local contrast against the background, using the seed appearance ranges. Then connected clusters (ROI rim band excluded), then per cluster: candidates from distance-transform peaks, circle fits to contour arcs and LoG peaks at prior scales. Greedy/beam selection over K ≤ K_max with local refinement of the objective. Manual centres of all groups are fixed disks. Output the best K, the runner-up K, the objective gap and a review flag. Sliders: sensitivity (λ / mask threshold) and prior width (multiplier on s). Re-running reuses cached planes, and only clusters affected by a parameter are refitted.
- **Phase 2 (option D)**: a learned pixel classifier (seeds and rejected suggestions as labels) replaces the hand-set foreground mask and appearance term in H. That is where H is weakest. Rejections are recorded in the run record. Optional explicit opt-in "use reviewed automated colonies as additional seeds", with their provenance staying automated (brief §5).
- **Phase 3 (research spike, gated)**: SlimSAM point-prompt as an alternative seed-radius estimator. Small permissively licensed ONNX detector only as a comparison, since the method brief excludes pretrained networks from the mainline.

### 6.2 Worker interface (proposal)

```ts
// src/detect/api.ts (proposed; not yet in repo)
export interface DetectRequest {
  runId: string                       // also used for cancellation
  imageId: string
  /** Either an ImageBitmap (transferable) or the original Blob; the worker decodes at analysis scale. */
  source: { kind: 'bitmap'; bitmap: ImageBitmap } | { kind: 'blob'; blob: Blob }
  /** Oriented original dimensions (ImageRecord.width/height) so results map back exactly. */
  imageSize: { width: number; height: number }
  /** In original-image px. Circle covers most plates; polygon later. */
  roi: { kind: 'circle'; cx: number; cy: number; r: number; edgeMarginFrac: number }
  /** Seed snapshot: manual annotations of the target group inside the ROI (fixed for the run, brief §4.1/§5). */
  targetGroupId: string
  seeds: { annotationId: string; x: number; y: number }[]
  /** Source-image identity, recorded in the run record (ImageRecord.fingerprint). */
  imageFingerprint: string
  /** All existing annotations, all groups incl. hidden: fixed disks in cluster fits + duplicate checks. */
  existing: { annotationId: string; x: number; y: number; groupId: string; origin: 'manual' | 'automated' }[]
  /** Labelled negatives from earlier rejections in this session (Phase 2). */
  negatives?: { x: number; y: number }[]
  params: {
    sensitivity: number               // 0..1 slider, mapped to count penalty λ / mask threshold
    priorWidth: number                // multiplier on the seed-derived log-radius scale s (default 1)
    kMax?: number                     // per-cluster cap; larger regions are returned as 'review' regions
    analysisMaxSide?: number          // override downsampling
    dedupeRadiusFactor: number        // fallback duplicate check for candidates outside any fitted cluster (default 0.6 × r)
  }
}

export type DetectEvent =
  | { type: 'progress'; runId: string; stage: string; fraction: number }
  | { type: 'result'; runId: string; result: DetectResult }
  | { type: 'error'; runId: string; code: 'too-few-exemplars' | 'roi-empty' | 'decode-failed' | 'out-of-memory' | 'internal'; message: string }

export interface DetectResult {
  detector: { name: string; version: string }      // e.g. 'blob-exemplar', '0.1.0'
  params: Record<string, unknown>                  // fully resolved params incl. analysis scale and calibrated threshold
  calibration: {
    seeds: { annotationId: string; x: number; y: number; radiusPx: number | null; quality: 'ok' | 'touching' | 'edge' | 'glare' | 'weak' }[]
    prior: { mu: number; s: number; sMin: number; nUsable: number }   // log-radius prior
    appearance: Record<string, { median: number; scale: number }>     // per-feature robust stats
    warnings: string[]                                                 // e.g. 'few usable seeds', 'no small seeds'
  }
  analysisScale: number
  suggestions: Suggestion[]
  clusters: ClusterResult[]
  timingsMs: Record<string, number>
}

export interface Suggestion {
  x: number; y: number                // original-image px (pixel-centre convention as types.ts)
  radiusPx: number                    // fitted colony radius, NOT AnnotationGroup.size
  clusterId: string
  quality: { boundaryResidual: number; priorDeviation: number }   // diagnostics, not probabilities
  confidence: number | null           // null unless separately calibrated (see 6.3)
}

export interface ClusterResult {
  clusterId: string
  bbox: [number, number, number, number]          // original-image px
  fixedManual: string[]                           // annotation IDs treated as fixed disks
  chosenK: number
  runnerUpK: number | null
  objectiveGap: number | null                     // J(runner-up) − J(chosen), normalised
  status: 'ok' | 'review' | 'too-large'
}
// Cancellation: postMessage({ type: 'cancel', runId }); the worker checks between stages.
```

Messaging: plain `postMessage` with transferables (`ImageBitmap` is transferable) is enough. A small RPC helper (or Comlink) is optional. One long-lived module Worker (`new Worker(new URL('./detect.worker.ts', import.meta.url), { type: 'module' })`, which Vite supports) keeps the cached planes (background, mask, gradient, labels) for the current image. Drop the cache when the image changes.

### 6.3 Mapping to `Annotation` / `DetectorProvenance`
- **Pending suggestions are not `Annotation`s.** Keep them in an ephemeral, per-image suggestion layer (in memory, optionally autosaved as a draft). They are drawn with a distinct style, never counted in totals or CSV (brief §8: "keep unaccepted suggestions separate from confirmed totals"), and don't enter undo history. This avoids having to filter `reviewStatus: 'unreviewed'` out of every count path, every CSV row and every Drive round trip.
- **Accept (batch or single)**: one `HistoryEntry` labelled e.g. "Accept 24 suggestions", containing N add-ops (`src/state/history.ts` already anticipates this label). Each created record:
  - `origin: 'automated'` (immutable), `lastEditSource: 'automated'`, `manuallyAdjusted: false`
  - `reviewStatus: 'accepted'`, `reviewedAt: now`, `groupId`: the target group (or the group chosen at accept time)
  - `detector: { name, version, runId, params, confidence: null }`. Keep `params` **per-annotation and small**: e.g. `{ clusterId, radiusPx, boundaryResidual, priorDeviation }`. Run-level data (seed snapshot, prior, settings) belongs in a run record, not duplicated N times.
- **Schema additions the method brief requires** (proposal for the schema owners; not in v1, and other agents own `types.ts`):
  - `ImageAnnotations.detectionRuns?: DetectionRun[]`, where `DetectionRun = { runId, method, version, createdAt, imageFingerprint, analysisScale, targetGroupId, seeds: {annotationId, x, y, radiusPx, quality}[], prior: {mu, s, sMin}, appearance, settings, diagnostics: {clusters: …summary…}, negatives?: {x, y}[] }`. Store only runs that produced at least one accepted annotation, and prune runs no annotation references any more. `Annotation.detector.runId` is the foreign key.
  - `Annotation.geometry?: { kind: 'circle'; r: number; quality?: number; source: 'fit' | 'seed-estimate' }` in original-image px, separate from `AnnotationGroup.size`. Manual seeds can get `geometry` too (estimated radius). That must never change their `origin`, `lastEditSource` or `manuallyAdjusted`.
  - Without a schema bump, the only v1-compatible fallback is to put the run record into every accepted annotation's `detector.params`. That works, but it bloats JSON and Drive files (the seed list is repeated N times), so I don't recommend it beyond a prototype.
- **Reject**: removes the suggestion from the layer and records it as a negative for this session. It creates no `Annotation`. If rejected suggestions should be auditable later, that is a schema v2 question (e.g. persist them with `reviewStatus: 'rejected'`). The current type supports that but count paths would have to exclude it.
- **Move after accept**: the normal edit path sets `manuallyAdjusted: true` and `lastEditSource: 'manual'`, and `origin` stays `'automated'` (types.ts already specifies this).
- **Confidence**: classical scores are not probabilities. Use `confidence: null` (the type's documented "not meaningful" value) until a calibration (e.g. Platt/isotonic fitted on harness data) exists. Don't write raw scores into `confidence`.
- **Radius**: see `Annotation.geometry` above. Never reuse `AnnotationGroup.size`.
- **Existing annotations and duplicates**: in the Worker, existing annotations of all groups (hidden included, since hidden still count) are fixed disks in the cluster fit, so they are counted as existing colonies rather than re-suggested (brief §4.7). At accept time the main thread re-checks against the current annotations (they may have changed since the run started), and refuses accepts into locked groups (the existing `checkOps` path).
- **Image identity**: refuse to run, or to accept results, while `ImageRecord.sourceMismatch` is set. That field was added to `types.ts` concurrently. Store `ImageRecord.fingerprint` in the run record so a run can't be applied to replaced bytes.
- **Seeds are not modified**: the run reads manual annotations but never moves or re-types them. Suggestions never become seeds for the same run.

### 6.4 Review UX
- Suggestions render as hollow rings in a neutral "pending" colour with the count shown separately ("24 suggested, not counted"). Sliders re-run only the cheap stages: changing λ or prior width refits clusters from cached planes and candidates, without decoding or re-segmenting.
- Actions: Accept all visible (one undo step), Accept in lasso/region, tap to toggle reject, Clear suggestions. Apple Pencil/touch hit-testing reuses the existing nearest-point logic.
- Show the seeds used, with their inferred radius rings and quality flags, and the status line ("8 manual examples; 6 usable"), so users can see *why* the detector chose a size. Offer "add another example" only when calibration is weak (brief §1).
- Clusters with status `review` are highlighted as regions (outline + "2 or 3?") rather than as committed points. Tapping one shows the alternatives: accept the chosen K, accept the alternative, or skip. "Accept all" accepts `ok` clusters only and leaves `review` clusters pending. `too-large` regions are shown as "count manually".
- Optional fitted outlines (circles) toggle on and off. They are diagnostics, separate from the group's display marker style.
- Never auto-accept. Never show suggestions as confirmed counts (brief §9).

### 6.5 Performance budget (12–24 MP phone photos, iPad Safari)
- Memory: a 12 MP image is 4000×3000; RGBA is 48 MB, one Float32 plane 48 MB, and a 5-scale DoG stack 240 MB. At 24 MP everything doubles. Full-resolution processing is not viable on iPad.
- **Analysis scale from exemplars, not a fixed size**: choose the downsample so the smallest expected colony radius (r_min after the size range) is ≈ 3–4 px. Example: a plate spanning 3000 px with 1 mm colonies at ~33 px/mm has a colony radius of ~16 px, so ×0.25 downsampling is fine. That gives 1000×750 for a full 12 MP frame, ~0.75 MP, well within budget. Cap the analysis image at ~4 MP. If tiny colonies force a higher resolution, process the ROI in overlapping tiles (overlap ≥ 2 × r_max) and merge with NMS. Crop to the ROI *before* downsampling.
- **Decode**: `createImageBitmap(blob, { resizeWidth, resizeHeight, resizeQuality: 'high' })` is supported since Safari/iOS 15, and `OffscreenCanvas` with a 2D context in Workers since Safari/iOS 16.4 (MDN browser-compat-data, checked 2026-10-09). This allows decode + resize + `getImageData` entirely in the Worker. **Verify EXIF orientation**: the worker's pixel grid must match `ImageRecord.width/height` (oriented). Test with rotated iPhone JPEGs and HEIC→JPEG conversions. `ImageDecoder` (WebCodecs) is not available on iOS Safari.
- Canvas limits: iOS Safari capped canvas area at 16,777,216 px (4096²) through iOS 17, and 67,108,864 px from iOS 18 ([PQINA](https://pqina.nl/blog/canvas-area-exceeds-the-maximum-limit/), [Lion Puro](https://lionpuro.com/posts/canvas-is-finally-usable-on-safari/)). Total canvas memory is also limited. Downsampled analysis canvases avoid both. Release buffers explicitly (`bitmap.close()`, `canvas.width = 0`).
- Time budget (*targets, to benchmark*): ≤1.5 s from Find to first suggestions on an iPad (M1 or recent A-series) for a 12 MP photo at the analysis scale. ≤300 ms slider updates (cluster refit from cached planes; *estimate*), first suggestions within a few seconds even on crowded plates, with progress per cluster batch. Report progress per stage. Cancel within one stage.
- Threads: ORT Web multi-threading and `SharedArrayBuffer` need cross-origin isolation (COOP/COEP headers), which GitHub Pages cannot send. The `coi-serviceworker` workaround exists but may interfere with Google Identity/Picker popups and iframes. That is a real conflict with the essential Drive integration. Stay single-threaded per Worker. Parallelise, if needed, with 2 Workers on separate tiles (plain transferables, no SAB).

### 6.6 Risks and unknowns
1. **Accuracy on real user plates is unknown.** Published numbers come from different imaging setups. The harness and a small set of real plates are the gate for every phase.
2. **Condensation, glare and colony-coloured media** are likely to dominate false positives on phone photos. Mitigations exist (colour model, rejections as negatives) but are unproven.
3. **Point-only exemplars**: the radius estimate can fail on irregular or spreading colonies, and the whole size model inherits that error. Show the estimated rings so users can spot it.
4. **Heterogeneous plates**: one exemplar set per group is a UX ask. Users may mark mixed exemplars in one group. Detect and warn.
5. **Partial ground truth** in the harness inflates FP counts. Tag plates as "complete".
6. **iPad memory**: Safari kills tabs under memory pressure without warning. Keep peak Worker memory well under ~300 MB (*estimate of a safe target*, to test).
7. **Licences**: GPL (OpenCFU, ImageJ plugin), AGPL (Ultralytics) and CC BY-NC (AGAR) all constrain reuse. The project has no licence yet. Decide before borrowing code, weights or data.
8. **ORT Web docs lag Safari**: ONNX Runtime's WebGPU page still says Safari is Technology Preview only ([ORT WebGPU EP](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html)), while WebKit shipped WebGPU on by default in Safari 26 on iOS/iPadOS 26 ([WebKit blog](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)). Operator coverage on WebGPU is a subset of WASM's ([ORT Web](https://onnxruntime.ai/docs/tutorials/web/)). Any Phase 3 model must be tested on real iPads.
9. **Method-brief specific**: the union-of-circles fit depends on the foreground mask, has five weights to tune (λ needs crowded, reviewed plates), will over-split irregular colonies, and inherits seed-radius and seed-selection bias. Details and mitigations are in §3.4. Persisting run records needs a schema bump that touches the storage, Drive and archive code that other agents own.
10. **Scope creep**: the brief makes the manual experience the priority. The detector must stay behind the interface and not shape core data paths beyond what §6.3 describes.

---

## 7. Sources

Classical / tools
- Geissmann Q. OpenCFU (2013), PLOS ONE: https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0054072 (arXiv: https://arxiv.org/pdf/1210.5502)
- Clarke et al. NICE (2010), Cytometry A: https://onlinelibrary.wiley.com/doi/10.1002/cyto.a.20864 · code: https://github.com/usnistgov/NICE-Public · NIST: https://www.nist.gov/publications/low-cost-high-throughput-automated-counting-bacterial-colonies
- Khan et al. AutoCellSeg (2018), Sci Rep: https://www.semanticscholar.org/paper/AutoCellSeg:-robust-automatic-colony-forming-unit-Khan-Torelli/4a8205ad11971f8c0c9684fa52ecd8e9e784b91c · code: https://github.com/AngeloTorelli/AutoCellSeg
- Chen, Huang, Kim, Cui, Buie. MCount (2025), PLOS ONE 20(3): e0311242: https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0311242 · code: https://github.com/hyu-kim/mcount
- Product-owner method brief: `colony-fitting-method-brief.md` (repo root, 2026-10-09)
- Bär, Boumasmoud, Zinkernagel, Vulin. ColTapp (2020), Sci Rep 10:16084: https://doi.org/10.1038/s41598-020-72979-4
- ImageJ Colony Counter: https://imagej.net/ij/plugins/colony-counter.html · CoCo: https://github.com/jiaxuanleong/coco
- scikit-image blob detection: https://scikit-image.org/docs/stable/auto_examples/features_detection/plot_blob.html
- OpenCV.js build measured from https://docs.opencv.org/4.13.0/opencv.js · npm `@techstark/opencv-js` (Apache-2.0)
- image-js: https://github.com/image-js/image-js · https://api.image-js.org/

Learning / counting
- ilastik pixel classification: https://www.ilastik.org/documentation/pixelclassification/pixelclassification · ilastik paper (Berg et al. 2019): https://d-nb.info/1209741083/34
- Arteta et al., Interactive Object Counting, ECCV 2014: https://link.springer.com/chapter/10.1007/978-3-319-10578-9_33
- Lempitsky & Zisserman, Learning To Count Objects in Images, NeurIPS 2010: https://www.robots.ox.ac.uk/~vgg/publications/2010/Lempitsky10b/lempitsky10b.pdf
- FamNet: https://arxiv.org/abs/2104.08391 · https://github.com/cvlab-stonybrook/LearningToCountEverything
- CounTR: https://arxiv.org/abs/2208.13721 · https://github.com/Verg-Avesta/CounTR
- DAVE: https://openaccess.thecvf.com/content/CVPR2024/html/Pelhan_DAVE_-_A_Detect-and-Verify_Paradigm_for_Low-Shot_Counting_CVPR_2024_paper.html · https://github.com/jerpelhan/DAVE
- GeCo: https://arxiv.org/html/2409.18686 · https://github.com/jerpelhan/GeCo · GeCo2: https://github.com/jerpelhan/GECO2 · https://arxiv.org/abs/2511.08048
- Colony Grounded SAM2: https://arxiv.org/abs/2603.13393
- SlimSAM / Transformers.js SAM: https://huggingface.co/posts/Xenova/240458016943176

Detectors / datasets
- AGAR: https://arxiv.org/abs/2108.01234 · https://agar.neurosys.com/ (CC BY-NC 2.0)
- Makrai et al. 2023, Sci Data: https://www.nature.com/articles/s41597-023-02404-8 · figshare: https://doi.org/10.6084/m9.figshare.22022540.v3
- SAHI colony counting (2026): https://pmc.ncbi.nlm.nih.gov/articles/PMC13451340/ · https://github.com/sercankulcu/SAHI-Colony-Counting · SAHI: https://github.com/obss/sahi
- Colony-YOLO (2025): https://doi.org/10.3390/microorganisms13071617
- Ultralytics (AGPL-3.0): https://github.com/ultralytics/ultralytics
- Review list: https://github.com/majsylw/microbial-counting-review

Browser platform
- ONNX Runtime Web: https://onnxruntime.ai/docs/tutorials/web/ · WebGPU EP: https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html · npm `onnxruntime-web` 1.30.0 (`ort-wasm-simd-threaded.wasm` 14,239,897 B; JSEP/WebGPU build 28,312,028 B, via jsDelivr listing)
- WebKit, Safari 26.0 features (WebGPU): https://webkit.org/blog/17333/webkit-features-in-safari-26-0/
- MDN browser-compat-data (createImageBitmap resize options Safari 15; OffscreenCanvas 2D Safari 16.4; ImageDecoder not on iOS): https://github.com/mdn/browser-compat-data
- Safari canvas limits: https://pqina.nl/blog/canvas-area-exceeds-the-maximum-limit/ · https://lionpuro.com/posts/canvas-is-finally-usable-on-safari/

## Product decisions (2026-10-09)

- **Schema adopted (no backward compatibility needed; still schema v1):** one JSON document per image holds both the annotations and a collection of automated runs. `ImageAnnotations.detectionRuns: DetectionRun[]` and `Annotation.geometry?` are now in `src/model/types.ts`. `Annotation.detector.runId` is the foreign key into `detectionRuns`.
- **Reference plates allowed:** seeds may come from another image (plate) in the project. Each `DetectionSeed` records its `imageId`, and the run records `seedImageFingerprints`, so cross-plate calibration is explicit and reproducible.
- **Test plates:** fully annotated test plates (including crowded ones) will be provided later for the evaluation harness.
