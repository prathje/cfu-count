# Colony counting from initial manual annotations

## Purpose and agreed approach

Use the user's **initial manually annotated colonies as the calibration examples**, estimate their size and appearance distributions from the underlying image, and use those distributions to constrain automatic annotation of the remaining colonies, including touching clusters.

Do not require a separate training dataset, a pretrained neural network, or a second mandatory calibration workflow. The intended interaction is:

**Annotate a few colonies → Find similar in this group → Review suggestions → Accept.**

This is a proposed extension to the colony-counter application, not a validated detector. The mathematical choices below are recommendations to prototype and test. All image processing and fitting must run in the browser; no inference server is required.

## 1. What to learn from the initial annotations

For the active annotation group, collect the existing manual annotation centres and inspect the corresponding image patches. Estimate, where the image supports it:

- Colony radius or area-equivalent radius.
- Foreground colour and contrast relative to the surrounding background.
- Circularity and edge strength as measurement-quality indicators.
- Optional radial intensity profile, if it is useful on the actual photographs.

**A point annotation supplies a location, not a radius.** Automatically estimate the boundary around that location using local foreground segmentation and/or radial edge evidence. Analyse more than one plausible scale rather than assuming the UI marker radius represents the colony. The display circle is purely cosmetic.

Keep this calibration automatic by default. Only ask for correction or another example if the image cannot support a reliable estimate. Mark seeds in touching clusters, on plate edges, or in glare as low-quality calibration examples rather than interpreting the whole connected region as one colony. Those centres still remain valid manual annotations and fitting constraints.

Use robust estimates from the reliable seeds. Show a compact status such as “8 manual examples; 6 usable for size estimation.” Do not silently discard manual counts. With too few reliable examples, provide tentative results or request more examples; there is no universally sufficient seed count.

“Extrapolate the distribution” means transfer the learned **size/appearance prior**, not extrapolate spatial density, multiply the number of clicks, or scatter new centres randomly. Every new annotation must have supporting image evidence.

## 2. A simple seed-derived distribution

Start with one robust radius distribution per annotation group and image. Do not pool groups, magnifications or imaging conditions automatically.

For reliable inferred radii \(r_1,\ldots,r_n\), work in log-radius:

\[
z_j=\log r_j,\qquad
\mu=\operatorname{median}(z_j),\qquad
s=\max\left(s_{\min},1.4826\operatorname{median}|z_j-\mu|\right).
\]

Use a Gaussian-shaped prior in log-radius, equivalent to a log-normal family for positive radii. Here the median and scaled median absolute deviation are a robust approximation, not a guarantee that colony sizes actually follow that distribution. A minimum scale \(s_{\min}\) prevents identical or nearly identical examples from creating an unrealistically narrow prior; choose it through validation and measurement resolution.

For small samples, broaden uncertainty instead of pretending the estimated distribution is exact. Evaluate whether a single distribution suffices before introducing mixtures or nonparametric density estimation. Do not infer a complex multimodal distribution from a handful of points.

Appearance can initially use robust per-feature ranges or diagonal variances rather than an unstable full covariance matrix. Normalise contrast against the local background to reduce sensitivity to uneven illumination. Treat size and colour ranges as **soft preferences**, not absolute exclusion rules.

Initial manual examples may favour large, easy-to-see colonies. Report poor coverage of small or unusual colonies and let users add examples naturally through the same annotation workflow. Do not claim that the manually chosen sample is statistically representative.

## 3. Geometric model for crowded regions

Represent colony \(i\) as a disk:

\[
D_i=\{x\in\mathbb R^2:\|x-c_i\|\le r_i\},
\qquad c_i=(x_i,y_i).
\]

The visible foreground of a cluster is approximated by the **union**, not the sum, of its disks:

\[
U_K=\bigcup_{i=1}^{K}D_i.
\]

Given a locally segmented foreground mask \(M\), compare plausible values of \(K\) and fit centres/radii with an objective such as:

\[
J(K,\theta)=
L_{\mathrm{mask}}(M,U_K)
+\alpha L_{\mathrm{edge}}(\partial M,\partial U_K)
+\beta\sum_{i=1}^{K}\rho\!\left(\frac{\log r_i-\mu}{s}\right)
+\gamma L_{\mathrm{appearance}}
+\lambda K.
\]

Interpretation:

| Term | Purpose |
| --- | --- |
| Mask loss | Penalise uncovered colony pixels and fitted foreground extending into background. A normalised symmetric-difference or overlap loss is a starting choice. |
| Edge loss | Align the predicted exposed boundary with observed arcs. Internal disk boundaries hidden by another disk are not expected to appear in the image. |
| Seed-derived size penalty | Prefer radii compatible with the initial manual examples, allowing outliers through a robust loss such as Huber loss. |
| Appearance loss | Prefer locally consistent colour/contrast when those features are reliable; avoid evaluating obscured interiors as if fully visible. |
| Count penalty | Discourage explaining noise with many unnecessary circles. |

This is a proposed regularised geometric fit, **not a literal reproduction of a published equation**. Normalise losses consistently and validate their weights, including resolution and cluster-size effects. The initial isolated seeds estimate morphology; they do not by themselves determine the correct count penalty for every crowded cluster. Tune that penalty on reviewed crowded examples during development and retain uncertainty when alternative counts fit similarly well.

Use circles first. Only add bounded ellipticity if real examples demonstrate a need; otherwise a flexible ellipse can explain two touching colonies as one large object. Do not use cluster area divided by mean colony area as the final count: overlap invalidates that simple relationship.

## 4. Practical fitting procedure

1. **Snapshot the calibration seeds.** Record manual annotation IDs, the source-image version and the active group.
2. **Estimate local background and foreground.** Exclude the plate rim and irrelevant regions. Retain an uncertainty signal for weak segmentation.
3. **Extract seed features and fit the prior.** Preserve inferred radii separately from display-marker size, including measurement-quality flags.
4. **Find connected foreground clusters.** Process local patches rather than fitting the entire plate jointly.
5. **Generate candidate circles.** Use distance-transform peaks for candidate centres and circle fits to visible contour arcs. Restrict the scale search softly using the seed-derived distribution.
6. **Fit and select candidates.** Start with a bounded candidate set, compare a few plausible counts, and refine centres/radii locally. Avoid an unconstrained exhaustive search over arbitrary circles.
7. **Preserve existing annotations.** Manual centres are fixed unless the user explicitly requests adjustment. Count them as existing colonies, not new suggestions. Include existing confirmed annotations across groups in duplicate checks; a detector must not add a second colony simply because the first belongs to another group. Hidden annotations still exist. Locked groups cannot be modified.
8. **Return suggestions and diagnostics.** Show proposed centres and optional inferred outlines. Keep proposals separate from confirmed counts. Accepting a batch is one undoable operation.

MCount provides a relevant published precedent for combining contour arcs, distance-transform-derived candidates and optimisation of circle selection [1]. ColTapp provides a complementary reference for distance transforms, watershed and circular Hough detection [2]. The specific **automatic prior estimation from the user's initial manual annotations** described here is our proposed adaptation, which needs its own validation.

## 5. Ambiguity and review

A prior constrains a fit; it cannot recover information absent from the image. Fully merged colonies may support several equally plausible counts. If the best two- and three-colony explanations are close, mark the cluster for review rather than automatically choosing a precise count with invented confidence.

Useful diagnostics include unexplained foreground, boundary residual, deviation from the seed distribution, the objective gap between competing counts and sensitivity to small seed/threshold changes. These are quality or stability measures, **not calibrated probabilities** unless separately validated.

Do not silently feed predicted colonies back into the calibration set. That risks reinforcing detector errors. Keep the seed snapshot fixed for a run. New manual annotations can update a later run; using reviewed automated annotations as calibration should be an explicit future option, and their original provenance must remain automated.

## 6. Browser implementation and saved records

Run the analysis in a cancellable Web Worker. A JavaScript/TypeScript implementation or a browser-compatible computer-vision/WASM library is a candidate; benchmark memory, responsiveness and iPad Safari behaviour before committing. Use a reduced-resolution analysis image where appropriate, then map outputs to original-image coordinates. No server-side processing or pretrained network is needed for this proposed method.

Keep these fields distinct:

- Annotation: ID, centre, group ID, immutable `origin: "manual" | "automated"`, review state, and edit metadata.
- Inferred geometry: fitted radius/boundary and its quality; not the group's display size.
- Detection run: method/version, seed annotation IDs, source-image identity/version, analysis scale, learned distribution parameters, fitting settings and diagnostics.

Save them in the existing per-image JSON and Drive workflow. Preserve seed-derived model parameters so suggestions can be explained and reproduced. CSV summaries distinguish manual-origin and automated-origin confirmed counts; unaccepted proposals are not included in confirmed totals. Human acceptance or repositioning does not change an automated annotation's origin.

## 7. Minimum validation before adoption

Compare the method against manually reviewed images with isolated, touching and heavily merged colonies. Use held-out colonies and clusters rather than testing only the calibration seeds. Where available, earlier images before merging can help establish ground truth.

Measure missed colonies, duplicate/false annotations, centre-location error, per-cluster count error and browser runtime/memory. Test whether results change excessively with different reasonable seed selections. Include different sizes, contrast levels, lighting and morphologies.

Compare at least a simple segmentation/watershed baseline with the seed-constrained circle fitter. Treat ambiguous clusters explicitly in the evaluation. The goal is useful, reviewable assistance rather than a forced count for every region.

## References

1. **Chen S, Huang P-H, Kim H, Cui Y, Buie CR (2025).** *MCount: An automated colony counting tool for high-throughput microbiology.* PLOS ONE 20(3): e0311242. [Paper](https://doi.org/10.1371/journal.pone.0311242) · [Author implementation](https://github.com/hyu-kim/mcount). Relevant for merged-colony geometry and selecting candidate circles using contour and regional evidence. Its reported benchmark results do not establish accuracy for our images or the proposed seed-derived adaptation.
2. **ColTapp (2020).** *Efficient microbial colony growth dynamics quantification with ColTapp, an automated image analysis application.* Scientific Reports. [Paper](https://doi.org/10.1038/s41598-020-72979-4). Relevant for a classical image-processing pipeline using distance transforms, watershed separation and circular Hough detection.

**Implementation decision:** prototype seed-derived, per-group size/appearance priors plus a constrained union-of-circles fit. Keep the initial manual-annotation workflow simple, and expose additional calibration controls only when image evidence is insufficient.
