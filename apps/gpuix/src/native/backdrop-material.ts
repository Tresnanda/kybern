import {spawnSync} from 'node:child_process'
import {useAppearance} from '../settings/appearance.ts'

// Like the app's reduced-motion preference, OS accessibility overrides are
// read at launch. App translucency changes remain reactive through useAppearance.
function preference(key: string, override: string): boolean {
  if (process.env[override]) return process.env[override] === '1'
  const result = spawnSync('defaults', ['read', 'com.apple.universalaccess', key], {encoding:'utf8'})
  return result.stdout?.trim() === '1'
}
export const BACKDROP_ALLOWED = !preference('reduceTransparency', 'KYBERN_REDUCED_TRANSPARENCY')
  && !preference('increaseContrast', 'KYBERN_INCREASED_CONTRAST')
export function useBackdropMaterial(): boolean {
  return useAppearance().translucent && BACKDROP_ALLOWED && process.env.KYBERN_OPAQUE !== '1'
}
/** Theme colors are resolved rgb()/rgba()/hex before reaching native styles. */
export function backdropTint(color: string, alpha = 0.78): string {
  if (color.startsWith('#')) {
    const raw=color.slice(1),hex=raw.length<=4?[...raw].map(c=>c+c).join(''):raw
    return `rgba(${parseInt(hex.slice(0,2),16)},${parseInt(hex.slice(2,4),16)},${parseInt(hex.slice(4,6),16)},${alpha})`
  }
  const values=color.match(/^rgba?\(([^)]+)\)$/)?.[1]?.split(/[\s,/]+/).filter(Boolean)
  return values?.length && values.length>=3?`rgba(${values[0]},${values[1]},${values[2]},${alpha})`:color
}
