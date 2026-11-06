// Lab for token-icon-check.ts: the composer's chips as the real TokenTextarea draws them (three image attachments, a file,
// a skill), at the composer's font size, so the check can look at where each chip's icon lands against its label.
import '../src/native/local-build.ts'
import { render, useGpuixRequired } from '@gpuix/react'
import { readFileSync } from 'node:fs'
import { useEffect, useState } from 'react'
import { installUiFont } from '../src/platform/fonts.ts'
import { ThemeProvider, useTheme } from '../src/ui.tsx'
import { TokenTextarea, type TokenTextareaHandle } from '../src/composer/TokenTextarea.tsx'
import { tokenIcon } from '../src/composer/token-icons.ts'
import { FONT_UI } from '../src/theme.ts'
import { createRef } from 'react'
const references = [
  ...['@image1', '@image2', '@image3'].map(token => ({ token, label: token.slice(1), icon: tokenIcon('attachment', token) })),
  { token: '@src/Composer.tsx', label: 'src/Composer.tsx', icon: tokenIcon('file', '@src/Composer.tsx') },
]
// The faces main.tsx registers before the first text is laid out.
const FONTS = ['CalSans-Regular.ttf', 'JetBrainsMono-Regular.ttf', 'JetBrainsMono-Light.ttf', 'JetBrainsMono-Medium.ttf', 'JetBrainsMono-LightItalic.ttf', 'JetBrainsMono-MediumItalic.ttf']
function Fonts({ children }: { children: React.ReactNode }) {
  const renderer = useGpuixRequired()
  const [ready, setReady] = useState(false)
  useEffect(() => {
    // KYBERN_LAB_NO_FONTS=1: the code face is not registered, as in a fixture that skips `main.tsx`'s fonts.
    for (const file of process.env.KYBERN_LAB_NO_FONTS ? [] : FONTS) (renderer as { registerFont: (bytes: Uint8Array) => void }).registerFont(readFileSync(new URL(`../src/assets/fonts/${file}`, import.meta.url)))
    installUiFont(renderer)
    setReady(true)
  }, [renderer])
  return ready ? children : null
}
function Lab() {
  const t = useTheme()
  const [value, setValue] = useState('@image1 @image2 @image3 @src/Composer.tsx look at these')
  const handle = createRef<TokenTextareaHandle>()
  return <div testId="app-ready" style={{ width: '100%', height: '100%', padding: 16, backgroundColor: t.v('--background') }}>
    <div style={{ width: 460, height: 64 }}>
      <TokenTextarea testId="composer" editorRef={handle} nativeRef={() => {}} references={references} value={value} onChange={e => setValue(e.value ?? '')}
        style={{ width: '100%', fontSize: 14, lineHeight: 19.6, color: t.text, fontFamily: FONT_UI }} />
    </div>
  </div>
}
render(<ThemeProvider><Fonts><Lab /></Fonts></ThemeProvider>, { title: 'token icons', width: 500, height: 120, focus: false })
