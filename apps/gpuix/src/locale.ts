// The desktop frontend formats dates, times and numbers with `toLocale*String(undefined, …)`, which the
// WKWebView answers with the system language ("18 Oct", "0:18" on an en-ID Mac, where WebKit resolves
// English regions macOS has no localization for to en-GB). Bun's `Intl` ignores the system and defaults
// to en-US ("Oct 18", "12:18 AM"). This makes the default locale the system's, so the desktop's own helpers
// (`@/lib/format`, `@/lib/providerUsage`) print the same text in GPUIX instead of being forked.
// Explicit locales are never touched; a platform without Foundation keeps the runtime default.
import { dlopen, FFIType, type Pointer } from 'bun:ffi'
import { cls, getObjc, sel } from './native/objc.ts'

/** English regions macOS ships its own localization for; every other English region resolves to en-GB. */
const ENGLISH_REGIONS = new Set(['US', 'GB', 'AU', 'CA', 'IN', 'IE', 'NZ', 'ZA'])

/** What WebKit reports as `navigator.language` for a system language tag ("en-ID" → "en-GB"). */
export function webKitLocale(tag: string): string {
  const [language = '', ...rest] = tag.replace(/_/g, '-').split('-')
  const region = rest.find((part) => /^[A-Za-z]{2}$|^\d{3}$/.test(part))?.toUpperCase()
  if (language.toLowerCase() === 'en' && region && !ENGLISH_REGIONS.has(region)) return 'en-GB'
  return region ? `${language.toLowerCase()}-${region}` : language.toLowerCase()
}

function systemLanguage(): string | null {
  if (process.platform !== 'darwin') return null
  try {
    dlopen('/System/Library/Frameworks/Foundation.framework/Foundation', { NSHomeDirectory: { args: [], returns: FFIType.ptr } }) // loads the framework so its classes resolve
    const o = getObjc()
    const locale = cls(o, 'NSLocale')
    if (!locale) return null
    const first = o.msgAt(o.msg(locale, sel(o, 'preferredLanguages')) as Pointer, sel(o, 'objectAtIndex:'), 0n) as Pointer | null
    const text = first ? String(o.msgCStr(first, sel(o, 'UTF8String'))) : ''
    return text || null
  } catch { return null }
}

/** The locale the desktop would format with, or null when it cannot be told. */
export function systemLocale(): string | null {
  const tag = systemLanguage()
  if (!tag) return null
  const locale = webKitLocale(tag)
  try { return Intl.DateTimeFormat.supportedLocalesOf([locale]).length ? locale : null } catch { return null }
}

const unset = (locales: unknown) => locales === undefined || (Array.isArray(locales) && locales.length === 0)

/** Make `locale` the default of the Date, Number and Intl formatters (idempotent). */
export function installDefaultLocale(locale: string) {
  const mark = '__kybernLocale'
  if ((Date.prototype as unknown as Record<string, unknown>)[mark]) return
  Object.defineProperty(Date.prototype, mark, { value: locale, enumerable: false })
  for (const name of ['toLocaleDateString', 'toLocaleTimeString', 'toLocaleString'] as const) {
    const original = Date.prototype[name]
    Date.prototype[name] = function (this: Date, locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) { return original.call(this, unset(locales) ? locale : locales, options) }
  }
  const numberString = Number.prototype.toLocaleString
  Number.prototype.toLocaleString = function (this: number, locales?: Intl.LocalesArgument, options?: Intl.NumberFormatOptions) { return numberString.call(this, unset(locales) ? locale : locales, options) }
  for (const name of ['DateTimeFormat', 'NumberFormat'] as const) {
    const original = Intl[name] as unknown as new (locales?: Intl.LocalesArgument, options?: object) => object
    ;(Intl as unknown as Record<string, unknown>)[name] = new Proxy(original, {
      apply: (target, self, args: [Intl.LocalesArgument?, object?]) => Reflect.apply(target as never, self, [unset(args[0]) ? locale : args[0], args[1]]),
      construct: (target, args: [Intl.LocalesArgument?, object?]) => Reflect.construct(target, [unset(args[0]) ? locale : args[0], args[1]]),
    })
  }
}

const locale = systemLocale()
if (locale) installDefaultLocale(locale)
