import '../src/native/local-build.ts'
import { render } from '@gpuix/react'
import { useState } from 'react'
function Lab() {
  const [value, setValue] = useState('a😀é')
  return <div testId="app-ready" style={{ width: '100%', height: '100%', padding: 32, backgroundColor: '#202020', display: 'flex', flexDirection: 'column', gap: 20 }}>
    <input secure autoFocus testId="secret" aria-label="Secret" value={value} onChange={e => setValue(e.value ?? '')} style={{ width: 300, height: 40, color: '#ffffff', fontSize: 20, backgroundColor: '#303030' }} />
    <text testId="length" style={{ color: '#eeeeee' }}>{`Characters ${Array.from(value).length}`}</text>
    <input testId="plain" placeholder="Ordinary input" style={{ width: 300, height: 40, color: '#ffffff' }} />
  </div>
}
render(<Lab />, { title: 'Secure input check', width: 420, height: 300, focus: false })
