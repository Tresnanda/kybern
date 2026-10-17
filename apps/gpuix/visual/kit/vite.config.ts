// Serves the desktop kit gallery (`gallery.html`) from this folder against the desktop's own components and
// stylesheets, so kit primitives can be photographed in WebKit exactly as the app renders them. Run from
// `apps/desktop` (dependencies resolve there): `pnpm exec vite --config ../gpuix/visual/kit/vite.config.ts`.
import path from 'node:path'
import { createRequire } from 'node:module'

const desktop = path.resolve(import.meta.dirname, '../../../desktop')
const require = createRequire(path.join(desktop, 'package.json'))
const react = require('@vitejs/plugin-react').default ?? require('@vitejs/plugin-react')
const tailwind = require('@tailwindcss/vite').default ?? require('@tailwindcss/vite')

export default {
  root: import.meta.dirname,
  plugins: [react(), tailwind()],
  resolve: {
    // Gallery files live outside the desktop package: point their few bare imports at its node_modules.
    alias: [
      { find: '@', replacement: path.join(desktop, 'src') },
      ...['react', 'react-dom', '@fontsource-variable/jetbrains-mono', '@fontsource/cal-sans'].map((name) => ({
        find: new RegExp(`^${name}(/|$)`),
        replacement: path.join(desktop, 'node_modules', name) + '/',
      })),
    ],
    dedupe: ['react', 'react-dom'],
  },
  server: { fs: { allow: [path.resolve(desktop, '../..')] } },
  clearScreen: false,
}
