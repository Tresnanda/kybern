// Lab for nested `paintTransform` scopes in a cached island that replays inside another scope (the onboarding's scene
// fill islands under their `Presence`): an outer scope held at identity (`retain`, as `Presence` does) around a cached
// island holding a red square at a retained opacity of 0 and a green square at a retained 80 px translation. `t` changes
// text beside the island, inside the outer scope, so the window renders and the island replays.
import '../src/native/local-build.ts'
import { render } from '@gpuix/react'
import { useState } from 'react'
const light = process.env.KYBERN_APPEARANCE === 'light'
function Lab() {
  const [tick, setTick] = useState(0)
  return <div testId="app-ready" onKeyDown={event => { if (event.key === 't') setTick(n => n + 1) }} style={{ width: '100%', height: '100%', backgroundColor: light ? '#f5f5f5' : '#202020' }}>
    <div paintTransform={{ initial: false, animate: { opacity: 1 }, retain: true }} style={{ position: 'absolute', left: 40, top: 40, width: 440, height: 220, display: 'flex', flexDirection: 'column' }}>
      <div style={{ position: 'absolute', left: 360, top: 8, display: 'flex' }}>
        {Array.from({ length: 4 }, (_, bit) => <div key={bit} style={{ width: 8, height: 8, backgroundColor: tick & (1 << bit) ? '#00ff00' : '#ff0000' }} />)}
      </div>
      <text testId="status" style={{ color: light ? '#202020' : '#eeeeee' }}>{`Tick ${tick}`}</text>
      <div style={{ width: 300, height: 160 }}>
        <div cache testId="island" style={{ width: 300, height: 160, backgroundColor: '#5070c0' }}>
          <div testId="hidden" paintTransform={{ initial: false, animate: { opacity: 0 }, retain: true }} style={{ position: 'absolute', left: 20, top: 20, width: 60, height: 60, backgroundColor: '#ff0000' }} />
          <div testId="moved" paintTransform={{ initial: false, animate: { translateX: 120 }, retain: true }} style={{ position: 'absolute', left: 20, top: 90, width: 60, height: 60, backgroundColor: '#00ff00' }} />
        </div>
      </div>
    </div>
  </div>
}
render(<Lab />, { title: 'Nested replay', width: 520, height: 300, focus: false })
