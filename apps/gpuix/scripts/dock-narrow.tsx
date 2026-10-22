// Same app in a deliberately narrow native window, without Accessibility or
// changing another process's window. Used only by dock-check.ts --narrow.
import '../src/native/local-build.ts'
import { render } from '@gpuix/react'
import { App } from '../src/App.tsx'
import { onWindowKeyDown } from '../src/nav/keys.ts'
import { connect } from '../src/state.ts'
import { ThemeProvider, VARIANT } from '../src/ui.tsx'
import { installWindowMaterial } from '../src/shell/windowMaterial.ts'

connect()
render(<ThemeProvider><App /></ThemeProvider>, {
  title: 'Kybern dock verification', appName: 'Kybern', width: 980, height: 820,
  minWidth: 900, minHeight: 600, titlebarTransparent: true,
  windowBackground: process.env.KYBERN_OPAQUE === '1' ? 'opaque' : 'blurred',
  trafficLightX: 16, trafficLightY: 16, focus: false, onKeyDown: onWindowKeyDown,
})
if (process.env.KYBERN_OPAQUE !== '1') installWindowMaterial({ mode: 'blurred', radius: 0 }, VARIANT)
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))
