// Use the real runtime theme tokens and production CSS in system WebKit.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { registerHooks } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const desktop = fileURLToPath(new URL("../", import.meta.url))
registerHooks({
  resolve(specifier, context, next) {
    const url = specifier.startsWith("@/") ? new URL("../src/" + specifier.slice(2), import.meta.url)
      : specifier.startsWith(".") && context.parentURL ? new URL(specifier, context.parentURL) : null
    if (url && existsSync(fileURLToPath(url) + ".ts")) return { shortCircuit: true, url: url.href + ".ts" }
    return next(specifier, context)
  },
})
const { buildThemeCssVariables, DEFAULT_THEME_STATE } = await import("../src/lib/kit/theme/theme.logic.ts")
const themes = Object.fromEntries(["dark", "light"].map((variant) => {
  const build = buildThemeCssVariables({ codeThemeId: DEFAULT_THEME_STATE.codeThemeIds[variant], theme: DEFAULT_THEME_STATE.chromeThemes[variant] }, variant, { electron: true, isMac: true, systemUiFont: true })
  return [variant, { ...build.variables, "--app-opaque-content-surface": build.variables["--color-background-surface"] }]
}))
const scratch = mkdtempSync(path.join(tmpdir(), "kybern-material-test-"))
try {
  const css = process.argv[2] ?? path.join(desktop, "dist/assets", readdirSync(path.join(desktop, "dist/assets")).find((name) => /^index-.*\.css$/.test(name)))
  readFileSync(css) // Fail clearly if the frontend has not been built.
  const themePath = path.join(scratch, "themes.json")
  writeFileSync(themePath, JSON.stringify(themes))
  const result = spawnSync("swift", [path.join(desktop, "scripts/check-window-material.swift"), css, themePath], { stdio: "inherit" })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
