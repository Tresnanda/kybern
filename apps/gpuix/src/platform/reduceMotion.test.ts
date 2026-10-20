import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Review 2026-10-21: Reduce Motion was read once at startup. It now follows the accessibility poll, as Reduce transparency
// and Increase contrast do; KYBERN_A11Y_FILE stands in for System Settings.
const file = path.join(mkdtempSync(path.join(tmpdir(), 'gpuix-a11y-')), 'a11y.json')
writeFileSync(file, JSON.stringify({ reduceMotion: false }))
process.env.KYBERN_A11Y_FILE = file
delete process.env.KYBERN_REDUCED_MOTION
const { refreshAccessibilityDisplay } = await import('./material.ts')
const ui = await import('../ui.tsx')
const { popupTransform } = await import('../motion/kit.tsx')
const { PATCHED_NATIVE } = await import('../native/local-build.ts')

;(PATCHED_NATIVE ? test : test.skip)('Reduce Motion changed in System Settings applies to the next motion', () => {
  expect(ui.REDUCED_MOTION).toBe(false)
  expect(popupTransform([0, 0])!.initial).toEqual({ opacity: 0, scale: 0.97 })
  writeFileSync(file, JSON.stringify({ reduceMotion: true }))
  refreshAccessibilityDisplay()
  expect(ui.REDUCED_MOTION).toBe(true)
  expect(popupTransform([0, 0])!.initial).toEqual({ opacity: 0 })
  writeFileSync(file, JSON.stringify({ reduceMotion: false }))
  refreshAccessibilityDisplay()
  expect(ui.REDUCED_MOTION).toBe(false)
})
