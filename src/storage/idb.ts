/** Minimal promise helpers over IndexedDB (no dependency). */

export function promisifyRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export interface DbSchema {
  name: string
  version: number
  upgrade(db: IDBDatabase, oldVersion: number, tx: IDBTransaction): void
  /**
   * Called when the connection is closed underneath us: another tab requested a
   * version change (we close so it is not blocked) or the browser closed it.
   * The owner must drop the handle and reopen lazily.
   */
  onClose?(): void
}

export function openDatabase(factory: IDBFactory, schema: DbSchema): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest
    try {
      req = factory.open(schema.name, schema.version)
    } catch (e) {
      reject(e)
      return
    }
    req.onupgradeneeded = (ev) => {
      schema.upgrade(req.result, ev.oldVersion, req.transaction!)
    }
    req.onsuccess = () => {
      const db = req.result
      // Another tab upgraded the schema: close so it is not blocked, and let the owner reopen later.
      db.onversionchange = () => {
        db.close()
        schema.onClose?.()
      }
      db.onclose = () => schema.onClose?.()
      resolve(db)
    }
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new DOMException('Database upgrade blocked by another open tab', 'InvalidStateError'))
  })
}

/**
 * Run `body` inside one transaction and resolve with its result once the
 * transaction has COMMITTED (not merely when the last request succeeded), so a
 * quota error raised at commit time is reported to the caller.
 */
export function runTransaction<T>(
  db: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  body: (tx: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction
    try {
      tx = db.transaction(stores, mode)
    } catch (e) {
      reject(e)
      return
    }
    let result: T
    let failed = false
    tx.oncomplete = () => {
      if (!failed) resolve(result)
    }
    tx.onabort = () => {
      failed = true
      reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError'))
    }
    tx.onerror = () => {
      // Abort follows; reject there with the transaction error.
    }
    Promise.resolve()
      .then(() => body(tx))
      .then(
        (r) => {
          result = r
        },
        (e) => {
          failed = true
          try {
            tx.abort()
          } catch {
            // already finished
          }
          reject(e)
        },
      )
  })
}
