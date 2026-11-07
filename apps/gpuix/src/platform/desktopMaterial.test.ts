import { expect, test } from 'bun:test'
import { desktopMaterialFor, windowsBuild } from './desktopMaterial.ts'
import { nativeBackground } from '../shell/windowMaterial.ts'
import { materialFor } from '../theme.ts'

test('picks the desktop material per OS, build and addon', () => {
  const all = ['mica', 'mica-alt', 'acrylic']
  expect(desktopMaterialFor('darwin', '25.0.0', [])).toBe('vibrancy')
  // On by default (DWM_BY_DEFAULT); off when not, and the pin turns it on either way.
  expect(desktopMaterialFor('win32', '10.0.22631', all)).toBe('dwm')
  expect(desktopMaterialFor('win32', '10.0.22631', all, undefined, false)).toBe('none')
  expect(desktopMaterialFor('win32', '10.0.22631', all, 'dwm')).toBe('dwm')
  expect(desktopMaterialFor('win32', '10.0.22631', all, undefined, true)).toBe('dwm')
  expect(desktopMaterialFor('win32', '10.0.22621', all, undefined, true)).toBe('dwm')
  expect(desktopMaterialFor('win32', '10.0.22000', all, undefined, true)).toBe('none') // Windows 11 21H2: no DWMWA_SYSTEMBACKDROP_TYPE
  expect(desktopMaterialFor('win32', '10.0.19045', all, undefined, true)).toBe('none') // Windows 10
  expect(desktopMaterialFor('win32', '10.0.22631', [], undefined, true)).toBe('none') // an addon without the materials
  expect(desktopMaterialFor('linux', '6.8.0', all)).toBe('none')
  expect(desktopMaterialFor('linux', '6.8.0', [], 'dwm', true, { translucent: false, blur: false })).toBe('none')
  expect(windowsBuild('10.0.26100')).toBe(26100)
  expect(windowsBuild('6.8.0-generic')).toBe(0)
})

test('maps the backing to the window background each OS takes', () => {
  const opaque = { mode: 'opaque', radius: 0 } as const, auto = { mode: 'blurred', radius: 0 } as const, custom = { mode: 'transparent', radius: 30 } as const
  expect([opaque, auto, custom].map(b => nativeBackground(b, 'vibrancy'))).toEqual(['opaque', 'blurred', 'transparent'])
  expect([opaque, auto, custom].map(b => nativeBackground(b, 'dwm'))).toEqual(['opaque', 'mica', 'acrylic'])
  expect([opaque, auto, custom].map(b => nativeBackground(b, 'none'))).toEqual(['opaque', 'opaque', 'opaque'])
})

test('an opaque window puts the frame coat on the Solid frame colour; the other regions keep their coats', () => {
  for (const variant of ['dark', 'light'] as const) for (const scope of ['sidebar', 'window'] as const) {
    const glass = materialFor(variant, scope, 90, scope === 'window' ? 90 : 100, null)
    const solid = materialFor(variant, scope, 90, scope === 'window' ? 90 : 100, null, 'none')
    // Light Sidebar only already paints an opaque frame coat.
    if (/, 1\)$/.test(glass.frame)) expect(solid.frame).toBe(glass.frame)
    else expect(solid.frame).toMatch(/^rgba\(\d+, \d+, \d+, 1\)$/)
    expect(solid.sidebar).toBe(glass.sidebar)
    expect(solid.content).toBe(glass.content)
  }
  expect(materialFor('dark', 'none', 100, 100, null, 'none')).toBe(materialFor('dark', 'none', 100))
})

test('Linux selects blur from capabilities and refuses alpha without composition', () => {
  expect(desktopMaterialFor('linux', '', [], undefined, true, { translucent: true, blur: true })).toBe('linux-blur')
  expect(desktopMaterialFor('linux', '', [], undefined, true, { translucent: true, blur: false })).toBe('linux-transparent')
  expect(desktopMaterialFor('linux', '', [], 'vibrancy', true, { translucent: false, blur: false })).toBe('none')
  const custom = { mode: 'transparent', radius: 64 } as const
  expect(nativeBackground(custom, 'linux-blur')).toBe('blurred')
  expect(nativeBackground(custom, 'linux-transparent')).toBe('transparent')
})

test('Linux defaults preserve readability on a sharp desktop', async () => {
  const { defaultVariantMaterial, normalizeVariantMaterial } = await import('./translucency.ts')
  for (const desktop of ['linux-transparent', 'none'] as const) {
    const m = defaultVariantMaterial('linux', desktop)
    expect(m.material).toBe('solid')
    expect(m.sidebarOpacity).toBe(97)
    expect(m.surfaceOpacity).toBe(95)
  }
  expect(defaultVariantMaterial('linux', 'linux-blur').material).toBe('translucent')
  expect(normalizeVariantMaterial({ surfaceOpacity: null }).surfaceOpacity).toBeNull()
})

test('Linux hides blur strength for every compositor; macOS keeps it', async () => {
  const { supportsBlurStrength, windowMaterialDescription } = await import('./desktopMaterial.ts')
  for (const material of ['vibrancy', 'dwm', 'none', 'linux-blur', 'linux-transparent'] as const) expect(supportsBlurStrength('linux', material)).toBe(false)
  expect(supportsBlurStrength('darwin', 'vibrancy')).toBe(true)
  expect(supportsBlurStrength('win32', 'dwm')).toBe(false)
  const gnome = desktopMaterialFor('linux', '', [], undefined, true, { translucent: true, blur: false })
  expect(windowMaterialDescription(gnome, 'GNOME')).toBe("This desktop can't blur, so the background shows through sharply. You can try the Blur my Shell extension.")
  expect(windowMaterialDescription(gnome, 'ubuntu:GNOME')).toContain('Blur my Shell')
  expect(windowMaterialDescription(gnome, 'Hyprland')).not.toContain('Blur my Shell')
})
