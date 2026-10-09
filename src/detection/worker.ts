/**
 * Module Worker entry. Bundled by Vite via
 *   new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
 * (see client.ts). All logic lives in worker-core.ts.
 */
import { browserDecoder, createWorkerHandler } from './worker-core.ts'
import type { FromWorker, ToWorker } from './protocol.ts'

interface WorkerScope {
  postMessage(m: FromWorker, transfer?: Transferable[]): void
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null
}
const scope = self as unknown as WorkerScope

const handle = createWorkerHandler(browserDecoder, (m, transfer) => scope.postMessage(m, transfer ?? []))
scope.onmessage = (e) => {
  void handle(e.data)
}
