import '../src/native/local-build.ts'
import { motion, render } from '@gpuix/react'
import { useState } from 'react'
function Lab() {
  const [active, setActive] = useState(false)
  const [clicks, setClicks] = useState(0)
  const [settles, setSettles] = useState(0)
  return <div testId="app-ready" style={{ width: '100%', height: '100%', padding: 20, backgroundColor: '#202020', display: 'flex', flexDirection: 'column', gap: 20 }}>
    <div testId="toggle" onClick={() => setActive(v => !v)} style={{ width: 150, height: 40, backgroundColor: '#444444' }}><text style={{ color: '#ffffff' }}>Toggle spring</text></div>
    <motion.div testId="spring" initial={false} animate={{ translateX: active ? 200 : 0, translateY: active ? 20 : 0 }} transition={{ type: 'spring', duration: 1, bounce: 0.4 }} onMotionComplete={() => setSettles(n => n + 1)} onClick={() => setClicks(n => n + 1)} style={{ width: 100, height: 50, backgroundColor: '#c05c3d', borderRadius: 8 }}>
      <text style={{ color: '#ffffff' }}>{`Clicks ${clicks}`}</text>
    </motion.div>
    <div testId="sibling" style={{ width: 100, height: 40, backgroundColor: '#333333' }}><text style={{ color: '#ffffff' }}>Stable sibling</text></div>
    <text testId="settles" style={{ color: '#ffffff' }}>{`Settled ${settles}`}</text>
  </div>
}
render(<Lab />, { title: 'Native spring and translation', width: 500, height: 320, focus: false })
