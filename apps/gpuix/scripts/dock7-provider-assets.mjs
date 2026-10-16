// Serialize the desktop's actual provider components. Regenerate before changing marks.
import { createElement } from '../../desktop/node_modules/react/index.js'
import { renderToStaticMarkup } from '../../desktop/node_modules/react-dom/server.node.js'
import { CursorIcon, DevinIcon, GrokIcon, PiIcon, OmpIcon, OpenCodeIcon, DroidIcon, AntigravityIcon } from '../../desktop/src/components/kit/Icons.tsx'
import { writeFileSync } from 'node:fs'
const icons = { cursor: CursorIcon, devin: DevinIcon, grok: GrokIcon, pi: PiIcon, omp: OmpIcon, opencode: OpenCodeIcon, droid: DroidIcon, antigravity: AntigravityIcon }
for (const [name, Component] of Object.entries(icons)) {
  const svg = renderToStaticMarkup(createElement(Component)).replaceAll('currentColor', '#000000')
  writeFileSync(new URL(`../src/assets/providers/${name}.svg`, import.meta.url), svg)
}
