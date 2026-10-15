import '../src/native/local-build.ts'
import { render } from '@gpuix/react'
const code = 'const message = "A long highlighted line stays readable when the panel narrows: 你好 🌱";\n' + 'const identifier' + 'WithoutBreaks'.repeat(12) + ' = 123;\n\n  return message;'
const style = { width: 300, minWidth: 0, fontSize: 14, lineHeight: 20, fontFamily: 'Menlo', color: '#eeeeee', backgroundColor: '#262626' }
render(<div testId="app-ready" style={{ width: '100%', height: '100%', padding: 20, backgroundColor: '#202020', display: 'flex', gap: 20 }}>
  <div style={{ width: 300 }}><code testId="plain" code={code} language="typescript" style={style} /></div>
  <div style={{ width: 300 }}><code testId="wrapped" softWrap code={code} language="typescript" showLineNumbers style={style} /></div>
</div>, { title: 'Highlighted code wrapping', width: 680, height: 440, focus: false })
