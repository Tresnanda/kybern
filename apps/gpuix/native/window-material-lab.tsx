// Window materials off macOS (WP9), for a look on a real desktop: CI captures read GPUI's scene, not what DWM composes
// behind it. MATERIAL_LAB_BACKGROUND=mica|mica-alt|acrylic|blurred|transparent|opaque (default mica); KYBERN_DWM_EXTEND_FRAME=0
// is the frame-extension control. A sidebar coat at 90%, a content coat at 60% and a frosted card, as the app paints them.
import '../src/native/local-build.ts'
import '../src/native/backdrop.ts'
import { render } from '@gpuix/react'
import { BACKDROP } from '../src/native/backdrop.ts'

const background = process.env.MATERIAL_LAB_BACKGROUND ?? 'mica'
render(
  <div testId="ready" style={{ width: '100%', height: '100%', display: 'flex' }}>
    <div style={{ width: 220, height: '100%', backgroundColor: 'rgba(19, 19, 19, 0.9)', padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {['Threads', 'Notes', 'Tasks', 'Settings'].map(item => <text key={item} style={{ color: '#e8e8ec', fontSize: 14 }}>{item}</text>)}
    </div>
    <div style={{ flexGrow: 1, height: '100%', backgroundColor: 'rgba(30, 30, 32, 0.6)', padding: 24, position: 'relative' }}>
      <text style={{ color: '#e8e8ec', fontSize: 16 }}>{`windowBackground: ${background}`}</text>
      {Array.from({ length: 12 }, (_, i) => <text key={i} style={{ color: '#c8c8cc', fontSize: 13 }}>{`Transcript line ${i + 1}: the desktop should show through this coat, blurred.`}</text>)}
      <div backdrop={{ ...BACKDROP.frost }} style={{ position: 'absolute', left: 60, top: 150, width: 320, height: 120, borderRadius: 16, backgroundColor: 'rgba(46, 46, 46, 0.55)', padding: 16 }}>
        <text style={{ color: '#ffffff', fontSize: 14 }}>A frosted card over the transcript</text>
      </div>
    </div>
  </div>,
  { title: 'Window material', width: 760, height: 440, windowBackground: background as 'opaque', titlebarTransparent: true, focus: true },
)
