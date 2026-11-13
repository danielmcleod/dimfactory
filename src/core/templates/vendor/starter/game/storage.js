// Saves small game data (high score, settings) as JSON. It never throws: when saving is not possible
// you simply get your defaults back.
// Part of the Dim Factory game starter. MIT License: copy, change and share it freely.

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))

/**
 * @param {object} options
 * @param {string} options.key Storage key, for example 'my-game'.
 * @param {number} [options.version] Bump it when the saved shape changes.
 * @param {any} options.defaults What load() returns when nothing usable is saved.
 * @param {{getItem, setItem, removeItem}} [options.storage] Default localStorage.
 * @param {(oldData: any, oldVersion: number) => any} [options.migrate] Turns older saved data into the current shape.
 */
export function createStorage(options) {
  const { key, version = 1, defaults, migrate } = options

  function backend() {
    try {
      return options.storage ?? globalThis.localStorage ?? null
    } catch {
      return null
    }
  }

  function fresh() {
    return copy(defaults)
  }

  /** Shallow-merges saved data over the defaults when both are plain objects. */
  function accept(data) {
    if (isPlainObject(defaults)) return isPlainObject(data) ? { ...fresh(), ...data } : fresh()
    if (Array.isArray(defaults)) return Array.isArray(data) ? data : fresh()
    return typeof data === typeof defaults ? data : fresh()
  }

  function load() {
    try {
      const raw = backend()?.getItem(key)
      if (typeof raw !== 'string') return fresh()
      const saved = JSON.parse(raw)
      if (!isPlainObject(saved) || typeof saved.v !== 'number' || !('data' in saved)) return fresh()
      if (saved.v > version) return fresh()
      if (saved.v < version) return migrate ? accept(migrate(saved.data, saved.v)) : fresh()
      return accept(saved.data)
    } catch {
      return fresh()
    }
  }

  /** Returns true when the data was saved, false when it could not be. */
  function save(data) {
    try {
      const store = backend()
      if (!store) return false
      store.setItem(key, JSON.stringify({ v: version, data }))
      return true
    } catch {
      return false
    }
  }

  function reset() {
    try {
      backend()?.removeItem(key)
    } catch {
      // Nothing to clean up if storage is not available.
    }
    return fresh()
  }

  return { load, save, reset, key }
}
