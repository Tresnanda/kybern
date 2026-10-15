/** bun scripts/visual-crop.ts <screen> <theme> x y w h — stacked Tauri/GPUIX crop (CSS px) → <screen>-<theme>-crop.png */
const [screen, theme, x, y, w, h] = process.argv.slice(2)
const dir = '/Users/mymac/projects/ade/previews/gpuix/visual'
const base = `${dir}/${screen}-${theme}`
const r = Bun.spawnSync(['swift', `${import.meta.dir}/../visual/crop.swift`, `${base}-tauri.png`, `${base}-gpuix.png`, `${base}-crop.png`, x!, y!, w!, h!])
console.log(r.exitCode === 0 ? `${base}-crop.png` : r.stderr.toString())
