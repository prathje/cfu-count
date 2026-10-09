/**
 * The detection pipeline: prepare → ROI → seed calibration → method.
 * Pure TypeScript on typed arrays; runs in a Worker, the main thread or node.
 */
import { measureSeed, radiusPrior, robustRange, seedQuality, calibrationSummary, coverageWarnings, type SeedMeasurement } from './calibrate.ts'
import { toLab } from './image/color.ts'
import { distanceTransform } from './image/distance.ts'
import { gaussianBlur, normalizedBlur } from './image/filters.ts'
import { makeMask, rasterBytes, type Plane } from './image/plane.ts'
import { median } from './image/threshold.ts'
import {
  colorAxisFromDiffs,
  contrastPlane,
  labBackground,
  labDiffAt,
  noiseSigma,
  prepareImage,
  weightMask,
  type LabBackground,
  type PreparedImage,
} from './features.ts'
import { nearFixed, sensitivityParams, maskThreshold, type AnalysisPrior, type FixedColony, type MethodContext } from './methods/common.ts'
import { runFitter } from './methods/fitter.ts'
import { priorRadii, runLog } from './methods/log.ts'
import { runWatershed, type MethodOutput } from './methods/watershed.ts'
import type {
  CalibrationReport,
  DetectInput,
  DetectProgress,
  DetectResult,
  DetectSettings,
  DetectionRun,
  ProgressFn,
  RadiusPrior,
  Roi,
  SeedInput,
  SeedReport,
} from './types.ts'

export const DETECTOR_VERSION = '0.1.0'

export const DEFAULT_SETTINGS: DetectSettings = {
  method: 'fitter',
  sensitivity: 0.5,
  priorWidth: 1,
  edgeMarginFrac: 0.025,
  kMax: 400,
  reviewGap: 0.25,
  sMin: 0.25,
  minUsableSeeds: 3,
}

/** Thrown when the AbortSignal fires; the worker reports it as `cancelled`. */
export class DetectionCancelled extends Error {
  constructor() {
    super('Detection cancelled')
    this.name = 'DetectionCancelled'
  }
}

/** Cache key for a prepared image: same pixels, scale, ROI and margin → reuse. */
export function prepareKey(imageId: string, scale: number, roi: Roi | undefined, edgeMarginFrac: number, width: number, height: number): string {
  return JSON.stringify([imageId, scale, roi ?? null, edgeMarginFrac, width, height])
}

/** Holds the last prepared image so slider re-runs skip Lab conversion and ROI detection. */
export class DetectorCache {
  private key: string | null = null
  private value: PreparedImage | null = null
  get(input: DetectInput, settings: DetectSettings): PreparedImage {
    const k = prepareKey(input.imageId, input.scale, input.roi, settings.edgeMarginFrac, input.image.width, input.image.height)
    if (k !== this.key || !this.value) {
      this.value = prepareImage(input.image, input.scale, input.roi, settings.edgeMarginFrac)
      this.key = k
    }
    return this.value
  }
  clear(): void {
    this.key = null
    this.value = null
  }
}

const newRunId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/**
 * Run detection. Results are in original-image px. Never mutates the input.
 * @throws DetectionCancelled when `signal` aborts.
 */
export async function detect(input: DetectInput, onProgress?: ProgressFn, signal?: AbortSignal, cache?: DetectorCache): Promise<DetectResult> {
  const settings: DetectSettings = { ...DEFAULT_SETTINGS, ...input.settings }
  const t0 = now()
  const timings: Record<string, number> = {}
  let lastStage: DetectProgress['stage'] = 'prepare'
  const checkpoint = async (fraction: number, stage: DetectProgress['stage'] = lastStage) => {
    if (signal?.aborted) throw new DetectionCancelled()
    lastStage = stage
    onProgress?.({ stage, fraction })
    await new Promise((r) => setTimeout(r, 0))
    if (signal?.aborted) throw new DetectionCancelled()
  }

  await checkpoint(0, 'prepare')
  const prep = cache ? cache.get(input, settings) : prepareImage(input.image, input.scale, input.roi, settings.edgeMarginFrac)
  timings.prepare = now() - t0
  await checkpoint(0.15, 'calibrate')

  // ---- calibration (two passes: background without, then with, a foreground exclusion)
  const t1 = now()
  const cal = calibrate(prep, input, settings)
  timings.calibrate = now() - t1
  await checkpoint(0.35, 'mask')

  // ---- method
  const t2 = now()
  const fixed = fixedColonies(input.existing, prep, cal)
  const ctx: MethodContext = {
    prep,
    F: cal.F,
    Fs: gaussianBlur(cal.F, Math.max(0.5, 0.15 * cal.priorA.rMed)),
    noise: cal.noise,
    prior: cal.priorA,
    contrastRef: cal.contrastRef,
    contrastLo: cal.contrastLo,
    fixed,
    settings,
    checkpoint: (f) => checkpoint(0.35 + 0.63 * f, f < 0.55 ? 'mask' : f < 0.6 ? 'candidates' : 'fit'),
  }
  const localSeedPts = cal.localSeedPts
  let out: MethodOutput
  if (settings.method === 'watershed') out = await runWatershed(ctx)
  else if (settings.method === 'log') out = await runLog(ctx, localSeedPts)
  else out = await runFitter(ctx, localSeedPts)
  timings.method = now() - t2

  // keep suggestions whose centre lies in the analysed region and inside the image,
  // and never one on top of an existing colony (any group)
  const roiMask = prep.roi.mask
  const suggestions = out.suggestions.filter((s) => {
    const x = Math.floor(s.x * prep.scale)
    const y = Math.floor(s.y * prep.scale)
    if (!(x >= 0 && y >= 0 && x < roiMask.width && y < roiMask.height && roiMask.data[y * roiMask.width + x] === 1)) return false
    if (!(s.x < input.originalWidth && s.y < input.originalHeight)) return false
    return !nearFixed(fixed, s.x * prep.scale, s.y * prep.scale, s.r * prep.scale, 0.5)
  })
  timings.total = now() - t0

  const sp = sensitivityParams(settings.sensitivity)
  const report = cal.report
  const runRoi: Roi = input.roi ?? outlineBox(prep.roi.report.outline)
  const crossPlate = input.seeds.some((s) => s.imageId !== input.imageId)
  const run: DetectionRun = {
    runId: input.runId ?? newRunId(),
    method: `colony-${settings.method}`,
    version: DETECTOR_VERSION,
    createdAt: new Date().toISOString(),
    imageFingerprint: '',
    ...(crossPlate ? { seedImageFingerprints: {} } : {}),
    analysisScale: prep.scale,
    targetGroupId: input.targetGroupId,
    roi: runRoi,
    seeds: report.seeds.map(({ annotationId, imageId, x, y, radiusPx, quality }) => ({ annotationId, imageId, x, y, radiusPx, quality })),
    prior: {
      radius: report.prior,
      priorWidth: settings.priorWidth,
      colorAxis: report.colorAxis,
      polarity: report.polarity,
      appearance: report.appearance,
      contrastRef: round(cal.contrastRef),
      noise: round(cal.noise),
      tentative: report.tentative,
    },
    settings: {
      ...settings,
      maskThreshold: round(maskThreshold(ctx)),
      lambda: sp.lambda,
      logRadiiPx: priorRadii(cal.priorA).map((r) => round(r / prep.scale)),
    },
    diagnostics: {
      suggestions: suggestions.length,
      clusters: out.clusters.length,
      review: out.clusters.filter((c) => c.status === 'review').length,
      tooLarge: out.clusters.filter((c) => c.status === 'too-large').length,
      roi: { source: prep.roi.report.source, shape: prep.roi.report.shape, marginPx: round(prep.roi.report.marginPx), area: Math.round(prep.roi.report.area) },
      timingsMs: Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, Math.round(v)])),
      method: out.diagnostics,
      warnings: report.warnings,
    },
  }
  const px = prep.width * prep.height
  // planes alive at the peak: RGBA + Lab + background + F/Fs + LoG stack (5) + method scratch (~3) + masks
  const peakRasterBytes =
    rasterBytes(input.image, prep.lab.L, prep.lab.a, prep.lab.b, cal.F, ctx.Fs) + 3 * 4 * px + (priorRadii(cal.priorA).length + 3) * 4 * px + 4 * px
  await checkpoint(1, 'done')
  return {
    method: settings.method,
    suggestions,
    clusters: out.clusters,
    calibration: report,
    roi: prep.roi.report,
    run,
    timingsMs: timings,
    peakRasterBytes,
    ...(input.includeClusterLabels ? { clusterLabels: { width: prep.width, height: prep.height, scale: prep.scale, labels: out.labels } } : {}),
  }
}

interface Calibrated {
  F: Plane
  noise: number
  priorA: AnalysisPrior
  contrastRef: number
  contrastLo: number
  report: CalibrationReport
  localSeedPts: { x: number; y: number }[]
}

interface MeasuredSeed {
  seed: SeedInput
  m: SeedMeasurement | null
  /** Plane px per original px of the seed's image. */
  scale: number
  originX: number
  originY: number
  note?: string
}

/** Seed calibration on the prepared image (and on cross-plate patches). */
export function calibrate(prep: PreparedImage, input: Pick<DetectInput, 'seeds' | 'imageId'>, settings: DetectSettings): Calibrated {
  const scale = prep.scale
  const plateW = weightMask(prep.roi.plate)
  const roiW = prep.roi.mask.data
  const sigma1 = Math.max(4, 0.05 * prep.plateDiameter)
  const bg1 = labBackground(prep.lab, plateW, sigma1)
  const local = input.seeds.filter((s) => s.imageId === input.imageId)
  const remote = input.seeds.filter((s) => s.imageId !== input.imageId)

  // cross-plate patches: own Lab + background
  const patches = remote.map((s) => {
    if (!s.patch) return null
    const lab = toLab(s.patch.image)
    const ones = new Uint8Array(s.patch.image.width * s.patch.image.height).fill(1)
    const sig = Math.max(4, Math.min(s.patch.image.width, s.patch.image.height) / 6)
    const bg: LabBackground = [normalizedBlur(lab.L, ones, sig), normalizedBlur(lab.a, ones, sig), normalizedBlur(lab.b, ones, sig)]
    return { lab, bg, px: (s.x - s.patch.originX) * s.patch.scale, py: (s.y - s.patch.originY) * s.patch.scale }
  })

  const diffs: [number, number, number][] = []
  for (const s of local) diffs.push(labDiffAt(prep.lab, bg1, s.x * scale, s.y * scale, 1))
  patches.forEach((p) => p && diffs.push(labDiffAt(p.lab, p.bg, p.px, p.py, 1)))
  const axis = colorAxisFromDiffs(diffs)

  const rMax = Math.max(6, 0.06 * prep.plateDiameter)
  const regionDistance = distanceTransform(prep.roi.mask)

  const measureAll = (F: Plane, noise: number): MeasuredSeed[] => {
    const out: MeasuredSeed[] = []
    for (const s of local) {
      const inImage = s.x >= 0 && s.y >= 0 && s.x * scale < prep.width && s.y * scale < prep.height
      out.push({
        seed: s,
        m: inImage ? measureSeed({ F, noise, rMax, saturated: prep.saturated, regionDistance }, s.x * scale, s.y * scale) : null,
        scale,
        originX: 0,
        originY: 0,
        note: inImage ? undefined : 'outside the image',
      })
    }
    remote.forEach((s, i) => {
      const p = patches[i]
      if (!p || !s.patch) {
        out.push({ seed: s, m: null, scale: 1, originX: 0, originY: 0, note: 'reference image not available' })
        return
      }
      const Fp = contrastPlane(p.lab, p.bg, axis)
      const all = makeMask(Fp.width, Fp.height, 1)
      const noiseP = noiseSigma(Fp, all.data)
      const rMaxP = Math.min(rMax * (s.patch.scale / scale), Math.min(Fp.width, Fp.height) / 2 - 1)
      out.push({
        seed: s,
        m: measureSeed({ F: Fp, noise: noiseP, rMax: rMaxP, regionDistance: distanceTransform(all) }, p.px, p.py),
        scale: s.patch.scale,
        originX: s.patch.originX,
        originY: s.patch.originY,
      })
    })
    return out
  }

  const usableRadii = (ms: MeasuredSeed[]) => ms.filter((q) => q.m && q.m.r !== null && seedQuality(q.m).quality === 'ok').map((q) => q.m!.r! / q.scale)

  // pass 1
  let F = contrastPlane(prep.lab, bg1, axis)
  let noise = noiseSigma(F, roiW)
  let measured = measureAll(F, noise)
  let prior = radiusPrior(usableRadii(measured), settings.sMin)
  let priorA = analysisPrior(prior, measured, scale, prep.plateDiameter, settings.priorWidth)
  // pass 2: exclude bright foreground from the background estimate
  {
    const contrasts = measured.filter((q) => q.m && q.m.snr >= 4).map((q) => q.m!.contrast)
    const ref = contrasts.length ? median(contrasts) : 8 * noise
    const thr = Math.max(3 * noise, 0.25 * ref)
    const fg = makeMask(prep.width, prep.height)
    for (let i = 0; i < fg.data.length; i++) fg.data[i] = F.data[i] > thr ? 1 : 0
    // dilate by ~half a colony so faint rims stay out of the background
    const inv = makeMask(prep.width, prep.height)
    for (let i = 0; i < inv.data.length; i++) inv.data[i] = fg.data[i] ? 0 : 1
    const dOut = distanceTransform(inv, false)
    // generous: halos and the gaps inside dense streaks must not lift the background
    const grow = Math.max(1, 1.5 * priorA.rMed)
    for (let i = 0; i < fg.data.length; i++) fg.data[i] = dOut.data[i] <= grow ? 1 : 0
    const sigma2 = Math.max(4, 4 * priorA.rHi, 0.04 * prep.plateDiameter)
    const bg2 = labBackground(prep.lab, weightMask(prep.roi.plate, fg), sigma2)
    F = contrastPlane(prep.lab, bg2, axis)
    noise = noiseSigma(F, weightMask(prep.roi.mask, fg))
    // remeasure local seeds on the better plane (patch seeds unchanged)
    measured = measureAll(F, noise)
    prior = radiusPrior(usableRadii(measured), settings.sMin)
    priorA = analysisPrior(prior, measured, scale, prep.plateDiameter, settings.priorWidth)
  }

  // ---- report
  const seeds: SeedReport[] = measured.map((q) => {
    const m = q.m
    const qual = m ? seedQuality(m) : { quality: 'weak' as const, note: q.note }
    return {
      annotationId: q.seed.annotationId,
      imageId: q.seed.imageId,
      x: q.seed.x,
      y: q.seed.y,
      radiusPx: m && m.r !== null ? round(m.r / q.scale) : null,
      quality: qual.quality,
      fitX: m ? round(m.cx / q.scale + q.originX) : q.seed.x,
      fitY: m ? round(m.cy / q.scale + q.originY) : q.seed.y,
      snr: m ? round(m.snr) : 0,
      ...(qual.note ? { note: qual.note } : {}),
    }
  })
  const usable = measured.filter((q) => q.m && q.m.r !== null && seedQuality(q.m).quality === 'ok')
  const contrasts = usable.map((q) => q.m!.contrast)
  const anyContrast = measured.filter((q) => q.m && q.m.snr >= 3).map((q) => q.m!.contrast)
  const contrastRef = contrasts.length ? median(contrasts) : anyContrast.length ? median(anyContrast) : 8 * noise
  const cr = robustRange(contrasts.length ? contrasts : [contrastRef], 0.15 * contrastRef)
  // soft lower bound: colonies may be dimmer than the (often large, bright) seeds
  const contrastLo = Math.min(0.5, Math.max(0.25, (cr.median - 3 * cr.scale) / contrastRef))
  const appearance: CalibrationReport['appearance'] = {}
  if (usable.length) {
    appearance.contrast = rr(cr)
    appearance.snr = rr(robustRange(usable.map((q) => q.m!.snr), 1))
    appearance.sharpness = rr(robustRange(usable.map((q) => q.m!.sharpness), 0.05))
    appearance.circularityCv = rr(robustRange(usable.map((q) => q.m!.cv), 0.02))
    const local = usable.filter((q) => q.seed.imageId === input.imageId)
    if (local.length) {
      const labAt = (q: MeasuredSeed, p: Plane) => p.data[Math.floor(q.m!.cy) * prep.width + Math.floor(q.m!.cx)]
      appearance.L = rr(robustRange(local.map((q) => labAt(q, prep.lab.L)), 1))
      appearance.a = rr(robustRange(local.map((q) => labAt(q, prep.lab.a)), 1))
      appearance.b = rr(robustRange(local.map((q) => labAt(q, prep.lab.b)), 1))
    }
  }
  const nTotal = input.seeds.length
  const nUsable = usable.length
  const base = { nTotal, nUsable, prior }
  const warnings = [...prep.roi.warnings, ...coverageWarnings(base, settings.minUsableSeeds)]
  if (!prior && priorA.fromFallback === 'touching') warnings.push('Size taken from examples that touch other colonies; it may be overestimated.')
  if (remote.length) warnings.push(`${remote.length} example${remote.length === 1 ? '' : 's'} taken from another plate; sizes assume the same camera setup.`)
  const report: CalibrationReport = {
    seeds,
    nTotal,
    nUsable,
    prior,
    appearance,
    polarity: axis[0] >= 0 ? 1 : -1,
    colorAxis: [round(axis[0]), round(axis[1]), round(axis[2])],
    summary: calibrationSummary(nTotal, nUsable),
    tentative: nUsable < settings.minUsableSeeds,
    warnings,
  }
  const localSeedPts = measured.filter((q) => q.seed.imageId === input.imageId && q.m).map((q) => ({ x: q.m!.cx, y: q.m!.cy }))
  return { F, noise, priorA, contrastRef, contrastLo, report, localSeedPts }
}

/**
 * Existing annotations as fixed colonies (analysis px). A known radius
 * (Annotation.geometry.r) is used as is; otherwise the colony under the mark
 * is measured like a seed. The measured centre is used for the loss only when
 * it is within half a radius of the mark (the annotation itself never moves).
 */
function fixedColonies(existing: DetectInput['existing'], prep: PreparedImage, cal: Calibrated): FixedColony[] {
  const { priorA } = cal
  const ctx = { F: cal.F, noise: cal.noise, rMax: Math.max(6, 2.5 * priorA.rHi) }
  return existing.map((e) => {
    const x = e.x * prep.scale
    const y = e.y * prep.scale
    if (e.r !== undefined) return { id: e.id, x, y, r: e.r * prep.scale }
    if (x < 0 || y < 0 || x >= prep.width || y >= prep.height) return { id: e.id, x, y, r: priorA.rMed }
    const m = measureSeed(ctx, x, y)
    if (m.r === null || m.snr < 3) return { id: e.id, x, y, r: priorA.rMed }
    const r = Math.min(Math.max(m.r, 0.6 * priorA.rMed), 1.6 * priorA.rHi)
    const near = Math.hypot(m.cx - x, m.cy - y) < 0.5 * r
    return { id: e.id, x: near ? m.cx : x, y: near ? m.cy : y, r }
  })
}

/** Prior in analysis px; falls back to any measured seed radius, then to a plate-relative guess. */
function analysisPrior(
  prior: RadiusPrior | null,
  measured: MeasuredSeed[],
  scale: number,
  plateDiameter: number,
  priorWidth: number,
): AnalysisPrior & { fromFallback?: 'touching' | 'guess' } {
  let logR: number
  let s: number
  let fromFallback: 'touching' | 'guess' | undefined
  if (prior) {
    logR = prior.mu + Math.log(scale)
    s = prior.s
  } else {
    const any = measured.filter((q) => q.m && q.m.r !== null).map((q) => Math.log(q.m!.r! / q.scale))
    if (any.length) {
      logR = median(any) + Math.log(scale)
      s = 0.4
      fromFallback = 'touching'
    } else {
      logR = Math.log(Math.max(3, 0.008 * plateDiameter))
      s = 0.6
      fromFallback = 'guess'
    }
  }
  s *= priorWidth
  const rMed = Math.exp(logR)
  return { logR, s, rMed, rLo: Math.max(1, Math.exp(logR - 2 * s)), rHi: Math.exp(logR + 2 * s), fromFallback }
}

function outlineBox(outline: { x: number; y: number }[]): Roi {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of outline) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y)
  }
  return { kind: 'rect', x: round(minX), y: round(minY), w: round(maxX - minX), h: round(maxY - minY) }
}

const round = (v: number) => Math.round(v * 1000) / 1000
const rr = (r: { median: number; scale: number }) => ({ median: round(r.median), scale: round(r.scale) })
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
