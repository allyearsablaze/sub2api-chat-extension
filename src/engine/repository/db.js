import { DB_NAME, DB_VERSION, STORE_DEFS } from './schema.js'
import { AppError } from '../common/errors.js'

let dbPromise = null

function ensureIndexes(db, tx) {
  for (const [storeName, def] of Object.entries(STORE_DEFS)) {
    const store = tx.objectStore(storeName)
    const existing = new Set(Array.from(store.indexNames || []))
    for (const index of def.indexes || []) {
      if (!existing.has(index.name)) {
        store.createIndex(index.name, index.keyPath, { unique: !!index.unique })
      }
    }
  }
}

export function openDatabase() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = (event) => {
      const db = request.result
      const tx = request.transaction
      for (const [storeName, def] of Object.entries(STORE_DEFS)) {
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName, {
            keyPath: def.keyPath,
            autoIncrement: !!def.autoIncrement
          })
        }
      }
      ensureIndexes(db, tx)
      void event
    }
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => db.close()
      resolve(db)
    }
    request.onerror = () => reject(new AppError(`打开数据库失败：${request.error?.message}`, 'DB_OPEN_FAILED'))
    request.onblocked = () => reject(new AppError('数据库被其他页面占用，请关闭重复打开的控制台', 'DB_BLOCKED'))
  })
  return dbPromise
}

function wrapRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(new AppError(request.error?.message || '数据库操作失败', 'DB_REQUEST_FAILED'))
  })
}

async function withStore(storeName, mode, handler) {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    let tx
    try {
      tx = db.transaction(storeName, mode)
    } catch (error) {
      reject(new AppError(`事务开启失败：${error.message}`, 'DB_TX_FAILED'))
      return
    }
    const store = tx.objectStore(storeName)
    let pending
    try {
      pending = Promise.resolve(handler(store))
    } catch (error) {
      reject(error)
      return
    }
    let value
    let failure = null
    pending.then(
      (result) => {
        value = result
      },
      (error) => {
        failure = error
      }
    )
    /**
     * 必须等事务真正提交（oncomplete）再返回。
     *
     * IndexedDB 的 request success 事件早于事务提交：若在 request 成功时就 resolve，
     * 紧接着开启的读事务可能还看不到刚写入的数据（写事务尚未提交）。
     * 典型症状是「刚入队的追加项在下一轮 claim 时读不到」——时序稍有变化就时好时坏。
     */
    tx.oncomplete = () => {
      if (failure) reject(failure)
      else resolve(value)
    }
    tx.onerror = () => reject(new AppError(tx.error?.message || '事务执行失败', 'DB_TX_FAILED'))
    tx.onabort = () => reject(new AppError(tx.error?.message || '事务被中断', 'DB_TX_ABORTED'))
  })
}

export const db = {
  async all(storeName) {
    const dbRef = await openDatabase()
    return wrapRequest(dbRef.transaction(storeName, 'readonly').objectStore(storeName).getAll())
  },

  async allByIndex(storeName, indexName, query = null) {
    const dbRef = await openDatabase()
    const store = dbRef.transaction(storeName, 'readonly').objectStore(storeName)
    return wrapRequest(store.index(indexName).getAll(query))
  },

  async get(storeName, key) {
    const dbRef = await openDatabase()
    return wrapRequest(dbRef.transaction(storeName, 'readonly').objectStore(storeName).get(key))
  },

  async count(storeName) {
    const dbRef = await openDatabase()
    return wrapRequest(dbRef.transaction(storeName, 'readonly').objectStore(storeName).count())
  },

  async put(storeName, value) {
    return withStore(storeName, 'readwrite', (store) => wrapRequest(store.put(value)))
  },

  async add(storeName, value) {
    return withStore(storeName, 'readwrite', (store) => wrapRequest(store.add(value)))
  },

  async remove(storeName, key) {
    return withStore(storeName, 'readwrite', (store) => wrapRequest(store.delete(key)))
  },

  async clear(storeName) {
    return withStore(storeName, 'readwrite', (store) => wrapRequest(store.clear()))
  },

  async bulkPut(storeName, values) {
    return withStore(storeName, 'readwrite', (store) => {
      for (const value of values) store.put(value)
      return values.length
    })
  },

  async bulkRemove(storeName, keys) {
    return withStore(storeName, 'readwrite', (store) => {
      for (const key of keys) store.delete(key)
      return keys.length
    })
  }
}

export function resetDatabaseConnection() {
  dbPromise = null
}
