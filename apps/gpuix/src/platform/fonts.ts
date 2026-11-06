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
  /** The UI face's space advance in em (Inter 576/2048, Segoe UI Variable 561/2048); null on macOS, which sizes by Menlo. */
  uiSpaceAdvance: number | null
  /**
   * How far below the middle of its line box the UI face's x-height is centred, in em: (ascent − descent − x-height) / 2,
   * whatever the line height. SF (952 / 241 / 527 per mille) 0.092, Inter 4.1 (1984 / 494 / 1118 of 2048) 0.091, Segoe UI
   * Variable (2210 / 514 / 1024 of 2048, its win metrics) 0.164. A mark beside text (a label's dot) sits there, not on the
   * middle of the line box.
   */
  uiXCentre: number
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

/** Inter's and Segoe UI Variable's space; another `KYBERN_UI_FONT` is assumed to have about Inter's. */
const INTER_SPACE = 576 / 2048, SEGOE_SPACE = 561 / 2048
/** `FontPlan.uiXCentre` of SF, Inter (also assumed for another `KYBERN_UI_FONT`) and Segoe UI Variable. */
const SF_X_CENTRE = (0.952 - 0.241 - 0.527) / 2, INTER_X_CENTRE = (1984 - 494 - 1118) / 2 / 2048, SEGOE_X_CENTRE = (2210 - 514 - 1024) / 2 / 2048

/** The plan for a platform. `KYBERN_UI_FONT` names another UI family off macOS (for the checks). */
export function fontPlan(platform: NodeJS.Platform, env: Record<string, string | undefined>, exists: (file: string) => boolean = existsSync): FontPlan {
  if (platform === 'darwin') return { systemUi: null, mono: 'Menlo', monoAdvance: 0.602, uiSpaceAdvance: null, uiXCentre: SF_X_CENTRE }
  const windows = env.WINDIR || env.SystemRoot || 'C:\\Windows'
  const segoe = platform === 'win32' && exists(path.win32.join(windows, 'Fonts', 'SegUIVar.ttf'))
  const systemUi = env.KYBERN_UI_FONT || (segoe ? SEGOE_VARIABLE : INTER)
  const segoeFace = systemUi === SEGOE_VARIABLE
  return { systemUi, mono: 'JetBrains Mono', monoAdvance: 0.6, uiSpaceAdvance: segoeFace ? SEGOE_SPACE : INTER_SPACE, uiXCentre: segoeFace ? SEGOE_X_CENTRE : INTER_X_CENTRE }
}

/**
 * How far to move a mark centred on a UI-font text line (`alignItems: 'center'`) down so its centre is on the text's x-height
 * centre, in px, for text of `fontSize`: a label's colour dot.
 */
export const xCentreNudge = (fontSize: number, plan: FontPlan = FONTS) => Math.round(plan.uiXCentre * fontSize * 100) / 100

/** Air kept between a chip's icon and its label, in px. */
export const CHIP_ICON_GAP = 1.5

/**
 * The run a composer chip reserves under its icon: the native input draws the first two characters of a chip in the icon's
 * `font` at the input's own size and paints the icon over them, so the room is whatever those characters advance. macOS
 * draws two Menlo spaces (`ui: false`). Elsewhere two JetBrains Mono spaces were wider than the icon only while that face
 * resolved; with the face unregistered (a lab, a fixture) or resolved late they fell back to the UI font's spaces, about
 * half as wide, and the icon covered the label's first letters. The UI face always resolves, so this pads with its own
 * spaces (`ui: true`: draw the first two in the UI font) in the count that clears the icon and `CHIP_ICON_GAP`.
 */
export function chipPad(plan: FontPlan, fontSize: number, iconSize: number): { text: string; ui: boolean } {
  if (plan.uiSpaceAdvance === null) return { text: '  ', ui: false }
  const count = Math.max(2, Math.ceil((iconSize + CHIP_ICON_GAP) / (plan.uiSpaceAdvance * fontSize)))
  return { text: ' '.repeat(count), ui: true }
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
