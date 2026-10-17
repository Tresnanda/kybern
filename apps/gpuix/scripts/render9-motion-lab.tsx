// render9 motion lab: the app's own components for the motions the paint-only subtree transform ports, side by side
// with `render9-motion-webkit.mjs` (the desktop's motion CSS in WebKit). Keys: o pop tile, s success check,
// d / e file drag enter / end over the drop card, r remount everything. Press: real mouse down on `press-*`.
import '../src/native/local-build.ts'
import { render, useGpuixRequired } from '@gpuix/react'
import { useEffect, useState } from 'react'
import { ThemeProvider, ChromeButton, Label, useTheme } from '../src/ui.tsx'
import { KitButton } from '../src/kit/AlertDialog.tsx'
import { Pop } from '../src/composer/motion.tsx'
import { Icon } from '../src/icons.tsx'
import { N } from '../src/nav/glyphs.ts'
import { successTransform } from '../src/motion/success.ts'
import { DropHighlight } from '../src/motion/DropHighlight.tsx'
import { Skeleton } from '../src/kit/Skeleton.tsx'

function Lab() {
  const t = useTheme()
  const renderer = useGpuixRequired() as unknown as { simulateFileDrag(x: number, y: number, paths: string[], phase: string): void }
  const [tile, setTile] = useState(0), [check, setCheck] = useState(0), [over, setOver] = useState(false), [key, setKey] = useState(0)
  useEffect(() => { process.stdout.write('') }, [])
  const action = (k: string) => {
    if (k === 'o') setTile(n => n + 1)
    if (k === 's') setCheck(n => n + 1)
    if (k === 'd') renderer.simulateFileDrag(470, 230, ['/tmp/render9-drop.png'], 'enter')
    if (k === 'e') renderer.simulateFileDrag(470, 230, ['/tmp/render9-drop.png'], 'end')
    if (k === 'r') setKey(n => n + 1)
  }
  return <div key={key} testId="app-ready" onKeyDown={e => action(e.key ?? '')} style={{ position: 'relative', width: '100%', height: '100%', backgroundColor: t.v('--background') }}>
    <div style={{ position: 'absolute', left: 24, top: 24, display: 'flex', gap: 16, alignItems: 'center' }}>
      <div testId="press-kit" style={{ display: 'flex' }}><KitButton variant="default" onClick={() => {}}>Continue</KitButton></div>
      <div testId="press-chrome" style={{ display: 'flex' }}><ChromeButton icon="plus" onClick={() => {}} /></div>
    </div>
    <div style={{ position: 'absolute', left: 24, top: 90, display: 'flex', gap: 8 }}>
      {tile > 0 && <Pop key={tile}>
        <div testId="pop-tile" style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 10, height: 56, width: 240, paddingLeft: 8, paddingRight: 32, borderRadius: 12, borderWidth: 1, borderColor: t.borderLight, backgroundColor: t.variant === 'dark' ? t.composer : '#ffffff' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 40, height: 40, borderRadius: 8, backgroundColor: t.v('--color-background-elevated-secondary') }}><Icon name="file" size={16} color={t.textSecondary} /></div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}><Label color={t.text} size={13} weight={500} lineHeight={16}>notes.md</Label><Label color={t.textSecondary} size={11} weight={500} lineHeight={14}>@notes MD</Label></div>
        </div>
      </Pop>}
    </div>
    <div style={{ position: 'absolute', left: 300, top: 90, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 40, height: 40, borderRadius: 20, backgroundColor: t.v('--success') + '1f' }}>
      {check > 0 && <div key={check} testId="success-check" paintTransform={successTransform()} style={{ display: 'flex' }}><Icon source={N.check} size={20} color={t.v('--success')} /></div>}
    </div>
    <div testId="drop-card" onFileDragChange={e => setOver(!!e.hovered)} onFileDrop={() => setOver(false)} style={{ position: 'absolute', left: 380, top: 180, width: 200, height: 100, borderRadius: 19.2, borderWidth: 1, borderColor: t.variant === 'dark' ? 'rgba(252, 252, 252, 0.052)' : 'rgba(13, 13, 13, 0.076)', backgroundColor: t.variant === 'dark' ? t.composer : '#ffffff' }}>
      <DropHighlight over={over} radius={19.2} color={t.v('--color-border-focus')} />
    </div>
    <text testId="drop-state" style={{ position: 'absolute', left: 380, top: 290, fontSize: 10, color: t.textSecondary }}>{over ? 'over' : 'out'}</text>
    <div style={{ position: 'absolute', left: 24, top: 180, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Skeleton testId="skel" width={300} height={16} view={{ width: 640, height: 320 }} />
      <Skeleton width={200} height={40} radius={10} view={{ width: 640, height: 320 }} />
    </div>
  </div>
}
render(<ThemeProvider><Lab /></ThemeProvider>, { title: 'render9 motion', width: 640, height: 320, focus: false })
