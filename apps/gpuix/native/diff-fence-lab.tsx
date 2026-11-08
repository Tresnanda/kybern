// Lab for diff-fence-check.ts (#294): `diff` fences as the transcript draws them (header + CodeChunk, unwrapped and wrapped)
// and inside Markdown that native `<markdown>` draws (a pull request summary, via FencedMarkdown). Removed lines on the
// removed tint, added lines green, hunk headers muted, context plain; the tag still reads `diff`.
import '../src/native/local-build.ts'
import { render, useGpuixRequired } from '@gpuix/react'
import { readFileSync } from 'node:fs'
import { useEffect, useState } from 'react'
import { installUiFont } from '../src/platform/fonts.ts'
import { ThemeProvider, useTheme } from '../src/ui.tsx'
import { cachedMarkdownTheme } from '../src/transcript/kit.tsx'
import { CodeChunk, CodeHeader, FencedMarkdown, type MarkdownPart } from '../src/transcript/markdown.tsx'

const FONTS = ['CalSans-Regular.ttf', 'JetBrainsMono-Regular.ttf', 'JetBrainsMono-Light.ttf', 'JetBrainsMono-Medium.ttf', 'JetBrainsMono-LightItalic.ttf', 'JetBrainsMono-MediumItalic.ttf']
function Fonts({ children }: { children: React.ReactNode }) {
  const renderer = useGpuixRequired()
  const [ready, setReady] = useState(false)
  useEffect(() => {
    for (const file of FONTS) renderer.registerFont!(readFileSync(new URL(`../src/assets/fonts/${file}`, import.meta.url)))
    installUiFont(renderer)
    setReady(true)
  }, [renderer])
  return ready ? children : null
}

const PATCH = `diff --git a/src/rpc/limits.ts b/src/rpc/limits.ts
--- a/src/rpc/limits.ts
+++ b/src/rpc/limits.ts
@@ -12,7 +12,9 @@ export function budget() {
   const standard = 16
-  const slow = standard
+  const slow = 8
+  const control = 8
   return { standard, slow }
 }
`
const ISSUE = '-[title + number / repository, reason, diff] [...]\n+[title + number or ... / repository, reason, diff]'
const SUMMARY = `This change gives slow calls their own lane, so a stuck \`git status\` can no longer starve the task list.

\`\`\`diff
${ISSUE}
\`\`\`

The tasks page now retries on its own and says so in plain words when it still cannot load.`

const part = (text: string): MarkdownPart => ({ kind: 'code', text, language: 'diff', key: 'diff' })

function Lab() {
  const t = useTheme()
  return <div testId="app-ready" style={{ width: '100%', height: '100%', padding: 20, display: 'flex', flexDirection: 'column', gap: 18, backgroundColor: t.v('--background') }}>
    <div testId="transcript-diff" style={{ display: 'flex', flexDirection: 'column', width: 560 }}>
      <CodeHeader part={part(PATCH)} expanded={false} wrap={false} onWrap={() => {}} />
      <CodeChunk text={PATCH} language="diff" wrap={false} />
    </div>
    <div testId="transcript-diff-wrapped" style={{ display: 'flex', flexDirection: 'column', width: 360 }}>
      <CodeHeader part={part(PATCH)} expanded={false} wrap onWrap={() => {}} />
      <CodeChunk text={PATCH} language="diff" wrap />
    </div>
    <div testId="summary" style={{ width: 560 }}>
      <FencedMarkdown source={SUMMARY} theme={cachedMarkdownTheme(t)} style={{ color: t.text, userSelect: 'text' }} />
    </div>
  </div>
}
render(<ThemeProvider><Fonts><Lab /></Fonts></ThemeProvider>, { title: 'Diff fences', width: 620, height: 960, focus: false })
