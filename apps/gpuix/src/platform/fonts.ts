// The faces Kybern draws text with on each OS (WP8, PORTING-PLATFORMS.md "Text"). macOS keeps the system font (SF, whose
// `wght` axis renders every kit weight: the zed fork's `font_weight.rs`) and Menlo. Windows and Linux have no variable UI
// font of their own (Segoe UI and the fontconfig sans are static families, so the kit's 450, 550 and 650 would snap to the
// nearest face): `.SystemUIFont`, and text with no `fontFamily`, resolve to Segoe UI Variable on Windows 11 and to the
// bundled Inter elsewhere (the addon's `setSystemUiFont`). Code uses the bundled JetBrains Mono there, and the code wrap
// and the checks compute with its advance.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export interface FontPlan {
  /** The family `.SystemUIFont` resolves to; null keeps the platform's own (macOS). */
  systemUi: string | null
  /** The code face. */
  mono: string
  /** The code face's advance in em (Menlo 1233/2048, JetBrains Mono 600/1000). */
  monoAdvance: number
}

/** Inter 4.1's variable roman and italic (`src/assets/fonts`, OFL; THIRD_PARTY_NOTICES.md). */
export const INTER = 'Inter Variable'
export const INTER_FILES = ['InterVariable.ttf', 'InterVariable-Italic.ttf']
/**
 * JetBrains Mono 2.304's SemiBold and Bold (the official release, OFL; THIRD_PARTY_NOTICES.md), for code at 600 and bold
 * syntax off macOS. macOS draws code in Menlo, and its JetBrains Mono uses (terminal, artifacts) keep the faces they had.
 */
export const MONO_WEIGHT_FILES = ['JetBrainsMono-SemiBold.ttf', 'JetBrainsMono-Bold.ttf']
/** Windows 11's variable UI font, in its text optical size. */
export const SEGOE_VARIABLE = 'Segoe UI Variable Text'

/** The plan for a platform. `KYBERN_UI_FONT` names another UI family off macOS (for the checks). */
export function fontPlan(platform: NodeJS.Platform, env: Record<string, string | undefined>, exists: (file: string) => boolean = existsSync): FontPlan {
  if (platform === 'darwin') return { systemUi: null, mono: 'Menlo', monoAdvance: 0.602 }
  const windows = env.WINDIR || env.SystemRoot || 'C:\\Windows'
  const segoe = platform === 'win32' && exists(path.win32.join(windows, 'Fonts', 'SegUIVar.ttf'))
  return { systemUi: env.KYBERN_UI_FONT || (segoe ? SEGOE_VARIABLE : INTER), mono: 'JetBrains Mono', monoAdvance: 0.6 }
}

export const FONTS = fontPlan(process.platform, process.env)

interface FontHost {
  registerFont?: (bytes: Uint8Array) => void
  setSystemUiFont?: (family: string | null) => void
}

/** The bundled files `installUiFont` registers for a plan: Inter only when the plan draws with it. */
export function uiFontFiles(plan: FontPlan): string[] {
  if (plan.systemUi === null) return []
  return [...(plan.systemUi === INTER ? INTER_FILES : []), ...MONO_WEIGHT_FILES]
}

/**
 * Off macOS: register the plan's bundled faces (`uiFontFiles`) and point `.SystemUIFont` at the plan's family. Call it with
 * the other bundled fonts, before the first text is laid out (a family resolved earlier keeps its font). A family that does
 * not resolve falls back to the platform's UI font at the same weight (the zed fork's `TextSystem::font_id`); an addon
 * without `setSystemUiFont` keeps the platform's UI font.
 */
export function installUiFont(renderer: object, plan: FontPlan = FONTS) {
  if (plan.systemUi === null) return
  const host = renderer as FontHost
  for (const file of host.registerFont ? uiFontFiles(plan) : []) {
    try {
      host.registerFont!.call(renderer, readFileSync(new URL(`../assets/fonts/${file}`, import.meta.url)))
    } catch (error) {
      console.error(`[fonts] ${file}:`, error)
    }
  }
  if (typeof host.setSystemUiFont === 'function') host.setSystemUiFont.call(renderer, plan.systemUi)
}
