// Live appearance lab: the hook-in `shell/appearance.ts` describes, on a bare
// window. After 2 s it flips NSApp's appearance (what macOS does when the user
// switches Light/Dark) and the poll in `shell/window.ts` must re-theme the lab.
//   bun scripts/shell-appearance.tsx   (driven by scripts/shell-appearance-run.ts)
import './../src/native/local-build.ts'
import type { Pointer } from 'bun:ffi'
import { render, useGpuixRequired } from '@gpuix/react'
import { useEffect } from 'react'
import { cls, cstr, getObjc, nsApp, sel } from '../src/native/objc.ts'
import { useSyncWindowAppearance, useSystemVariant } from '../src/shell/appearance.ts'
import { startWindowShell } from '../src/shell/window.ts'
import { THEMES, materialFor } from '../src/theme.ts'
import { Label, ThemeProvider, VARIANT } from '../src/ui.tsx'

function flip(name: 'NSAppearanceNameAqua' | 'NSAppearanceNameDarkAqua') {
  const o = getObjc()
  const named = o.msgPtrArg(cls(o, 'NSAppearance'), sel(o, 'appearanceNamed:'), o.msgPtrArg(cls(o, 'NSString'), sel(o, 'stringWithUTF8String:'), cstr(name))) as Pointer
  o.msgSetPtr(nsApp()!, sel(o, 'setAppearance:'), named)
}

function Lab() {
  const renderer = useGpuixRequired()
  const system = useSystemVariant(VARIANT)
  const t = THEMES[system]
const fills = materialFor(system, 'none', 100)
  useSyncWindowAppearance(system)
  useEffect(() => {
    startWindowShell(renderer)
    const a = setTimeout(() => flip(system === 'dark' ? 'NSAppearanceNameAqua' : 'NSAppearanceNameDarkAqua'), 2000)
    return () => clearTimeout(a)
  }, [])
  return (
    <div testId="app-ready" style={{ display: 'flex', width: '100%', height: '100%', backgroundColor: fills.frame, alignItems: 'center', justifyContent: 'center' }}>
      <div testId="variant"><Label color={t.text} size={24}>{`system: ${system}`}</Label></div>
    </div>
  )
}
render(<ThemeProvider><Lab /></ThemeProvider>, { title: 'appearance-lab', width: 600, height: 300, windowBackground: 'blurred', focus: process.env.GPUIX_BACKGROUND !== '1' })
