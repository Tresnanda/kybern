import '../src/native/local-build.ts'
import { render } from '@gpuix/react'
import { useState } from 'react'
import { Label, useTheme } from '../src/ui.tsx'

function Row({ n, onClick, cached = true }: { n: number; onClick?: () => void; cached?: boolean }) {
  const t = useTheme(), [hover, setHover] = useState(false)
  return <div cache={cached} style={{ width: 320, height: 32 }}>
    <div testId={`row-${n}`} onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} style={{ width: 320, height: 32, backgroundColor: hover ? t.hover : 'transparent', hover: { borderColor: t.text, borderWidth: 1 } }}>
      <Label color={t.text} style={{ pointerEvents: 'none' }}>{`Row ${n}; hover ${hover}`}</Label>
    </div>
  </div>
}
function Lab() {
  const [shifted, setShifted] = useState(false), [transformed, setTransformed] = useState(false)
  const t = useTheme(), [open, setOpen] = useState(false), [moved, setMoved] = useState(false)
  return <div testId="app-ready" style={{ width: '100%', height: '100%', backgroundColor: t.v('--background'), padding: 20, userSelect: 'none' }}>
    <div testId="toggle" onClick={() => setOpen(v => !v)} style={{ height: 32 }}><Label color={t.text}>Collapse / expand</Label></div>
    <div testId="reflow" onClick={() => setMoved(v => !v)} style={{ height: 32 }}><Label color={t.text}>Reflow cached rows</Label></div>
    {open && <div style={{ height: 96 }} />}
    <div style={{ paddingTop: moved ? 48 : 0 }}><Row n={-1} onClick={() => setMoved(v => !v)} /></div>
    <virtual-list {...{cache: 'fill' as const}} testId="list" estimatedItemHeight={32} style={{ width: 320, height: 224 }}>
      {Array.from({ length: 30 }, (_, n) => <Row key={n} n={n} cached={false} />)}
    </virtual-list>
    <div paintTranslate={{initial:false,animate:{translateX:shifted?180:0,translateY:0},transition:{duration:.15}}} style={{width:320,height:32}}>
      <Row n={-2} onClick={() => setShifted(true)} />
    </div>
    <div paintTransform={{initial:false,animate:{translateX:transformed?180:0,scale:transformed ? .8 : 1},transition:{duration:.15}}} style={{width:320,height:32}}>
      <Row n={-3} onClick={() => setTransformed(true)} />
    </div>
    <text testId="prose" style={{ color: t.text, userSelect: 'text' }}>Selectable transcript prose remains selectable.</text>
    <markdown testId="document" source="Selectable **formatted document** remains selectable." style={{userSelect:'text'}} />
    <code testId="source" code="const selectable = true;" showLineNumbers={false} style={{userSelect:'text'}} />
  </div>
}
render(<Lab />, { title: 'HR5 stationary hover', width: 600, height: 650, focus: false })
