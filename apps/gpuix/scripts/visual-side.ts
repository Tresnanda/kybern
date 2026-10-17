/** bun scripts/visual-side.ts <screen> <theme> x y w h (VISUAL_OUT=<dir>) — Tauri | GPUIX crop side by side → <screen>-<theme>-side.png */
const [screen, theme, x, y, w, h] = process.argv.slice(2)
const dir = process.env.VISUAL_OUT ?? '/Users/mymac/projects/ade/previews/gpuix/visual'
const base = `${dir}/${screen}-${theme}`
const r = Bun.spawnSync(['swift', `${import.meta.dir}/../visual/side.swift`, `${base}-tauri.png`, `${base}-gpuix.png`, `${base}-side.png`, x!, y!, w!, h!])
console.log(r.exitCode === 0 ? `${base}-side.png` : r.stderr.toString())
