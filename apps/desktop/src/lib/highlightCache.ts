export interface HighlightCacheValue {
  dark: boolean
  lang: string
  code: string
  html: string
}

export interface HighlightCacheOptions {
  maxBytes?: number
  maxEntries?: number
}

type CacheEntry = HighlightCacheValue & { bytes: number }

/**
 * LRU storage for settled highlighted output.
 *
 * The source is the final nested-map key, so it is retained once rather than
 * copied into a composite theme/language/source key. The entry object keeps
 * the same string reference for accounting and replacement bookkeeping.
 */
export function createHighlightCache({ maxBytes = 4 * 1024 * 1024, maxEntries = 24 }: HighlightCacheOptions = {}) {
  const cache = new Map<string, Map<string, Map<string, CacheEntry>>>()
  const lru = new Map<CacheEntry, true>()
  let bytes = 0

  const remove = (entry: CacheEntry) => {
    const themeKey = entry.dark ? "dark" : "light"
    const theme = cache.get(themeKey)
    const language = theme?.get(entry.lang)
    if (language?.get(entry.code) === entry) {
      language.delete(entry.code)
      if (language.size === 0) theme?.delete(entry.lang)
      if (theme?.size === 0) cache.delete(themeKey)
      bytes -= entry.bytes
    }
    // Always remove the LRU record, even if a newer entry replaced this map
    // slot while an overlapping worker request was completing.
    lru.delete(entry)
  }

  const get = (dark: boolean, lang: string, code: string): string | undefined => {
    const theme = cache.get(dark ? "dark" : "light")
    const language = theme?.get(lang)
    const entry = language?.get(code)
    if (!entry) return undefined
    lru.delete(entry)
    lru.set(entry, true)
    return entry.html
  }

  const set = (value: HighlightCacheValue) => {
    const entry: CacheEntry = { ...value, bytes: (value.lang.length + value.code.length + value.html.length) * 2 }
    const themeKey = value.dark ? "dark" : "light"
    let theme = cache.get(themeKey)
    if (!theme) { theme = new Map(); cache.set(themeKey, theme) }
    let language = theme.get(value.lang)
    if (!language) { language = new Map(); theme.set(value.lang, language) }
    const existing = language.get(value.code)
    if (existing) {
      // Replace in place. Calling remove here would prune the empty namespace
      // maps before the new entry is installed, leaving the replacement
      // detached from `cache` when it was the only entry in that namespace.
      lru.delete(existing)
      bytes -= existing.bytes
    }
    language.set(value.code, entry)
    lru.set(entry, true)
    bytes += entry.bytes
  }

  const evict = () => {
    while (lru.size > maxEntries || bytes > maxBytes) {
      const oldest = lru.keys().next().value
      if (!oldest) break
      remove(oldest)
    }
  }

  return {
    get,
    set(value: HighlightCacheValue) {
      if ((value.lang.length + value.code.length + value.html.length) * 2 > maxBytes) return
      set(value)
      evict()
    },
    clear() {
      cache.clear()
      lru.clear()
      bytes = 0
    },
    get size() { return lru.size },
    get bytes() { return bytes },
  }
}
