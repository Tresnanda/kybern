import '../src/native/local-build.ts'
import {render, useGpuixRequired} from '@gpuix/react'
import {readFileSync} from 'node:fs'
import {useEffect, useState, type ReactNode} from 'react'
import {installUiFont} from '../src/platform/fonts.ts'
import {THEMES} from '../src/theme.ts'
import {markdownTheme} from '../src/transcript/kit.tsx'
// One link per paragraph, drawn in a colour nothing else uses so its underline can be found in a capture: inline code
// in a link (mixed-size inline flow, one fragment per word), a bold link in a single text run, bold and code in one
// link, a link wrapped onto two lines in both layouts, and links that lead with an icon (green). The underline mode
// comes from KYBERN_LINK_UNDERLINE (`always` or `hover`).
export const LINK_INK = '#e01ee0', ICON_INK = '#10b010'
const t = THEMES[process.env.KYBERN_APPEARANCE === 'light' ? 'light' : 'dark'], base = markdownTheme(t)
const underline = process.env.KYBERN_LINK_UNDERLINE === 'always' ? 'always' : 'hover'
const theme = {...base, markdown: {...base.markdown, link: {...base.markdown.link, color: LINK_INK, underline}, linkIcons: [{prefix: 'https://icon.example/', svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="4" fill="${ICON_INK}"/></svg>`, color: ''}]}}
export const CASES: Record<string, {source: string; lines: number; icon?: boolean}> = {
  code: {source: 'See [the `render.rs` module docs](https://example.com/a) here.', lines: 1},
  bold: {source: 'Read **[the bold link text](https://example.com/b)** now.', lines: 1},
  mixed: {source: 'Read [**bold** and `code` parts](https://example.com/c) now.', lines: 1},
  wrapFlow: {source: 'With `a` [one underline for every line of a link long enough to wrap](https://example.com/d) on.', lines: 2},
  wrapPlain: {source: 'With a [one underline for every line of a link long enough to wrap](https://example.com/e) on.', lines: 2},
  icon: {source: 'Open [the site with an icon](https://icon.example/x) today.', lines: 1, icon: true},
  iconFlow: {source: 'Open [the `site` with an icon](https://icon.example/y) today.', lines: 1, icon: true},
}
// The app's bundled faces, as `main.tsx` registers them: the icon slot is two code-face spaces wide.
const FONTS = ['JetBrainsMono-Regular.ttf', 'JetBrainsMono-Light.ttf', 'JetBrainsMono-Medium.ttf', 'JetBrainsMono-LightItalic.ttf', 'JetBrainsMono-MediumItalic.ttf']
function Fonts({children}: {children: ReactNode}) {
  const renderer = useGpuixRequired()
  const [ready, setReady] = useState(false)
  useEffect(() => {
    for (const file of renderer.registerFont ? FONTS : []) renderer.registerFont!(readFileSync(new URL(`../src/assets/fonts/${file}`, import.meta.url)))
    installUiFont(renderer)
    setReady(true)
  }, [renderer])
  return ready ? children : null
}
function Lab() {
  return <div testId="ready" style={{width: '100%', height: '100%', backgroundColor: t.surface, padding: 24, display: 'flex', flexDirection: 'column', gap: 18}}>
    {Object.entries(CASES).map(([id, {source}]) => <markdown key={id} testId={id} source={source} theme={theme} style={{width: id.startsWith('wrap') ? 330 : 520, color: t.text, userSelect: 'text'}}/>)}
  </div>
}
if (import.meta.main) render(<Fonts><Lab/></Fonts>, {title: 'Link underline', width: 600, height: 520, focus: false})
