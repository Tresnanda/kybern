// Lab for a panned `paintTransform` inside an `overflow: hidden` viewport (the image preview's zoom stage, ADE-71): a
// 200 × 480 stage of four colour bands in a 200 × 120 viewport, with a border-only box in the last band. Keys pan it.
import '../src/native/local-build.ts'
import { render } from '@gpuix/react'
import { useState } from 'react'
type Value = { scale?: number; translateY?: number }
const BANDS = ['#c03030', '#30a040', '#3050c0', '#e0c020']
function Lab() {
  const [value, setValue] = useState<Value>({})
  const action = (key: string) => {
    // The last band fills the viewport; the second band over the third; doubled, the last band again.
    if (key === 'p') setValue({ translateY: -360 })
    if (key === 'm') setValue({ translateY: -180 })
    if (key === 'k') setValue({ scale: 2, translateY: -720 })
    if (key === 'z') setValue({})
  }
  return <div testId="app-ready" onKeyDown={event => action(event.key ?? '')} style={{ width: '100%', height: '100%', backgroundColor: '#202020' }}>
    <div testId="viewport" style={{ position: 'absolute', left: 40, top: 60, width: 200, height: 120, overflow: 'hidden', backgroundColor: '#808080' }}>
      <div testId="stage" paintTransform={{ initial: false, animate: value, transition: { duration: 0 }, origin: [0, 0], retain: true }}
        style={{ position: 'absolute', left: 0, top: 0, width: 200, height: 480 }}>
        {BANDS.map((color, i) => <div key={color} style={{ position: 'absolute', left: 0, top: i * 120, width: 200, height: 120, backgroundColor: color }} />)}
        <div testId="ring" style={{ position: 'absolute', left: 60, top: 380, width: 80, height: 80, borderWidth: 4, borderColor: '#d040d0' }} />
      </div>
    </div>
  </div>
}
render(<Lab />, { title: 'Pan clip', width: 320, height: 260, focus: false })
