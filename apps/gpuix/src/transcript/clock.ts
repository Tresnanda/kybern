// Message times the way WKWebView prints them: through the macOS locale and the
// 12/24-hour preference (`AppleICUForce24HourTime`, `AppleLocale`). Bun's Intl uses
// ICU's default "en-US" and ignores both, so "22:28" came out as "10:28 PM".
// `+[NSDateFormatter dateFormatFromTemplate:options:locale:]` with the "jm" template
// returns the exact pattern the system would use ("HH:mm", "h:mm a", "HH.mm" …).
import { dlopen, FFIType, type Pointer } from 'bun:ffi'
import { clockTime as fallbackClockTime } from '../../../desktop/src/lib/format.ts'
import { cstr, cls, getObjc, sel } from '../native/objc.ts'

let pattern: string | null | undefined

function systemPattern(): string | null {
  if (process.platform !== 'darwin') return null
  try {
    dlopen('/System/Library/Frameworks/Foundation.framework/Foundation', { NSHomeDirectory: { args: [], returns: FFIType.ptr } }) // loads the framework so its classes resolve
    const o = getObjc()
    const send3 = dlopen('/usr/lib/libobjc.A.dylib', { objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.ptr } }).symbols.objc_msgSend
    const nsString = cls(o, 'NSString'), formatter = cls(o, 'NSDateFormatter'), locale = cls(o, 'NSLocale')
    if (!nsString || !formatter || !locale) return null
    const template = o.msgPtrArg(nsString, sel(o, 'stringWithUTF8String:'), cstr('jm')) as Pointer
    const current = o.msg(locale, sel(o, 'currentLocale')) as Pointer
    const result = send3(formatter, sel(o, 'dateFormatFromTemplate:options:locale:'), template, 0n, current) as Pointer | null
    // WebKit prints en_ID's "HH.mm" as "22:28" (it follows the hour cycle, not the separator).
    return result ? String(o.msgCStr(result, sel(o, 'UTF8String'))).replace(/(?<=[Hhkm])\.(?=m)/g, ':') : null
  } catch { return null }
}

const two = (n: number) => String(n).padStart(2, '0')

/** Format `date` with a CLDR pattern limited to what "jm" produces: H, h, m, a and literals. */
export function formatWithPattern(date: Date, fmt: string): string {
  const h24 = date.getHours(), h12 = h24 % 12 === 0 ? 12 : h24 % 12
  let out = ''
  for (let i = 0; i < fmt.length;) {
    const c = fmt[i]!
    if (c === "'") { const end = fmt.indexOf("'", i + 1); out += end < 0 ? fmt.slice(i + 1) : fmt.slice(i + 1, end) || "'"; i = end < 0 ? fmt.length : end + 1; continue }
    let run = 1
    while (fmt[i + run] === c) run++
    if (c === 'H' || c === 'k') out += run > 1 ? two(h24) : String(h24)
    else if (c === 'h' || c === 'K') out += run > 1 ? two(h12) : String(h12)
    else if (c === 'm') out += run > 1 ? two(date.getMinutes()) : String(date.getMinutes())
    else if (c === 'a' || c === 'b' || c === 'B') out += h24 < 12 ? 'AM' : 'PM'
    else out += c.repeat(run)
    i += run
  }
  return out.replace(/ /g, ' ').replace(/[  ]+/g, ' ').trim()
}

/** Short clock time for a message ("22:28" or "10:28 PM", per the system settings). */
export function clockTime(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  if (pattern === undefined) pattern = systemPattern()
  return pattern ? formatWithPattern(new Date(t), pattern) : fallbackClockTime(iso)
}
