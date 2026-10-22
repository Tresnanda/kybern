// Check the window material patch (src/native/material.ts) on a bare blurred window.
//   KYBERN_DEBUG_MATERIAL=1 bun scripts/material-check.tsx   patched: material=21, tint + filters
//   SKIP=1 bun scripts/material-check.tsx                    GPUI as shipped: material=4, none
import { render } from '@gpuix/react'
import { describeMaterial } from '../src/native/material.ts'
import { installWindowMaterial } from '../src/shell/windowMaterial.ts'
render(
  <div testId="app-ready" style={{ display: 'flex', width: '100%', height: '100%', backgroundColor: 'rgba(45, 45, 45, 0.88)' }} />,
  { title: process.env.SKIP ? 'material-gpui-blur' : 'material-desktop-vibrancy', width: 400, height: 300, titlebarTransparent: true, windowBackground: 'blurred', focus: false },
)
if (!process.env.SKIP) installWindowMaterial({ mode: 'blurred', radius: 0 }, 'dark')
else setTimeout(describeMaterial, 800)
setTimeout(() => process.exit(0), Number(process.env.HOLD_MS ?? 3000))
