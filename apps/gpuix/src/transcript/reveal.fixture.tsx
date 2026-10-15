import '../native/local-build.ts'
import { render } from '@gpuix/react'
import { useState } from 'react'
import { useSmoothText } from './motion.tsx'
import { ThemeProvider, useTheme } from '../ui.tsx'
import { Button } from './kit.tsx'
const source = 'A calm stream preserves whole words and Unicode 🌿 while the provider pauses between bursts. '.repeat(12)
function Fixture() {
  const t = useTheme(), [target, setTarget] = useState(''), [complete, setComplete] = useState(false)
  const shown = useSmoothText(target, !complete, complete)
  return <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', backgroundColor: t.surface }}><Button testId="burst" onClick={() => setTarget(source)}>Receive burst</Button><Button testId="finish" onClick={() => setComplete(true)}>Complete</Button><text testId="shown" style={{ color: t.text }}>{shown}</text></div>
}
render(<ThemeProvider><Fixture /></ThemeProvider>, { title: 'Reveal verification', width: 900, height: 600, focus: false })
process.stdin.on('end', () => process.exit(0))
