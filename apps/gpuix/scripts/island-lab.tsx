// Cached-island lab (patched GPUIX): 300 sidebar-like rows and a ticking loader,
// plain or with every row and the loader as a `cache` island.
//   NAPI_RS_NATIVE_LIBRARY_PATH=native/build/gpuix-native.darwin-arm64.node \
//   KYBERN_LOADER_TICK_MS=100 bun scripts/island-lab.tsx plain|island
import { render } from '@gpuix/react'
import { useEffect, useState } from 'react'
import { MatrixLoader } from '../src/MatrixLoader.tsx'
import { Label, ThemeProvider, useTheme } from '../src/ui.tsx'

const island = process.argv[2] === 'island'
const CACHE = (island ? { cache: true } : {}) as Record<string, unknown>
// The loader is always an island (MatrixLoader marks itself).

function Row({ i }: { i: number }) {
  const t = useTheme()
  return (
    <div {...CACHE} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', height: 28, flexShrink: 0, paddingLeft: 12, borderRadius: 8, ...(process.env.ISLAND_LAB_NO_HOVER ? {} : { hover: { backgroundColor: t.hover } }) }}>
      <div style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: '#D97757' }} />
      <Label color={t.text} truncate>{`Thread row ${i + 1} with a reasonably long title`}</Label>
      {i === 1 && !process.env.ISLAND_LAB_STILL && <MatrixLoader cycle={1600} />}
    </div>
  )
}

/** Changes 800 ms after mount: a stale island would keep showing "early". */
function Late() {
  const t = useTheme()
  const [late, setLate] = useState(false)
  useEffect(() => {
    const id = setTimeout(() => setLate(true), 800)
    return () => clearTimeout(id)
  }, [])
  return (
    <div {...CACHE} style={{ display: 'flex', width: 200, height: 40, alignItems: 'center' }}>
      <Label color={t.text}>{late ? 'late: island updated' : 'early'}</Label>
    </div>
  )
}

function OverlayLab() {
  const t = useTheme()
  const [outside, setOutside] = useState(0)
  const [clicks, setClicks] = useState(0)
  return <div testId="app-ready" style={{ width: '100%', height: '100%', backgroundColor: t.surface }}>
    <div {...CACHE} style={{ width: 300, height: 100 }}>
      <Label color={t.text}>Cached parent</Label>
      <anchored position={{ x: 400, y: 80 }} style={{ width: 200, height: 100, backgroundColor: t.surface }}>
        <div testId="island-overlay" onClick={() => setClicks(n => n + 1)} style={{ width: 200, height: 100, backgroundColor: t.buttonSecondary }}>
          <Label color={t.text}>{`Overlay clicks ${clicks}`}</Label>
        </div>
      </anchored>
    </div>
    <div testId="outside-update" onClick={() => setOutside(n => n + 1)} style={{ width: 240, height: 60, backgroundColor: t.buttonSecondary }}>
      <Label color={t.text}>{`Outside ${outside}`}</Label>
    </div>
  </div>
}

function Lab() {
  const t = useTheme()
  return (
    <div testId="app-ready" style={{ display: 'flex', width: '100%', height: '100%', backgroundColor: t.surface, padding: 16, gap: 16 }}>
      {process.env.ISLAND_LAB_LIST ? (
        <div style={{ display: 'flex', flexDirection: 'column', width: 320, height: 780 }}>
          <virtual-list estimatedItemHeight={28} style={{ flexGrow: 1, minHeight: 0 }}>
            {Array.from({ length: 300 }, (_, i) => <div key={i} style={{ display: 'flex', paddingTop: 2 }}><Row i={i} /></div>)}
          </virtual-list>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', width: 320, overflow: 'hidden' }}>
          {Array.from({ length: 300 }, (_, i) => <Row key={i} i={i} />)}
        </div>
      )}
      <Late />
      {!process.env.ISLAND_LAB_STILL && (
        <div testId="loader" style={{ display: 'flex', width: 14, height: 14 }}>
          <MatrixLoader cycle={1600} />
        </div>
      )}
    </div>
  )
}
render(<ThemeProvider>{process.env.ISLAND_LAB_OVERLAY ? <OverlayLab /> : <Lab />}</ThemeProvider>, { title: `island-lab ${island ? 'island' : 'plain'}`, width: 1000, height: 820, focus: false })
