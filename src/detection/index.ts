/**
 * Colony detection — public API.
 *
 *   detect(input, onProgress?, signal?) → DetectResult      (pure, any thread)
 *   createDetectorClient()                                   (Web Worker wrapper, browser)
 *   chooseAnalysisScale(...)                                 (pick the analysis resolution)
 *
 * See docs/research/detection-results.md for the method, parameters and the
 * proposed UI integration. Suggestions are pending proposals in ORIGINAL
 * image px: they are never Annotations until the user accepts them (see
 * `suggestionsToAnnotations`).
 */
export { detect, calibrate, DetectorCache, DetectionCancelled, DEFAULT_SETTINGS, DETECTOR_VERSION } from './detect.ts'
export { chooseAnalysisScale, type ScaleChoice, type ScaleRequest } from './scale.ts'
export { suggestionsToAnnotations, type AcceptOptions } from './accept.ts'
export type * from './types.ts'
