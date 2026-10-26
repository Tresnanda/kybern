// Type specimen for text-check.ts (WP8): the kit's weights in the UI font and in Inter, the kit's sizes and line heights in
// Inter and JetBrains Mono (bundled, so the same font on every OS: line boxes and baselines compare across platforms), code
// in the code face, inline code at the rich editor's reduced scale (`kszl`), emoji and CJK fallback.
import '../src/native/local-build.ts'
import { readFileSync } from 'node:fs'
import { useState } from 'react'
import { render, useGpuixRequired } from '@gpuix/react'
import { RichEditor } from '../src/editor/RichEditor.tsx'
import { registerBrandFonts } from '../src/native/fonts.ts'
import { INTER, INTER_FILES } from '../src/platform/fonts.ts'
import { FONT_MONO, FONT_UI } from '../src/theme.ts'
import { BACKGROUND, CAPS, CJK, EMOJI, FOREGROUND, INLINE, LADDER, MONO, MONO_PROBE, MONO_PROBE_SIZE, MONO_SIZE, SIZES, WEIGHTS, WRAP, WRAP_WIDTH } from './text-specimen.ts'

const rgb = (c: readonly number[]) => `rgb(${c.join(', ')})`
const fg = rgb(FOREGROUND), muted = 'rgb(150, 150, 150)'
const line = (family: string, size: number, lineHeight: number, weight = 400) => ({ color: fg, fontFamily: family, fontSize: size, lineHeight, fontWeight: weight, whiteSpace: 'nowrap', alignSelf: 'flex-start' }) as const
const heading = (label: string) => <text style={{ color: muted, fontFamily: FONT_UI, fontSize: 11, lineHeight: 16, marginTop: 6 }}>{label}</text>

function Lab() {
  const renderer = useGpuixRequired()
  // Before the first layout: the code face and, off macOS, the UI font (`platform/fonts.ts`); Inter on macOS too, for the
  // cross-platform rows.
  useState(() => {
    registerBrandFonts(renderer)
    if (process.platform === 'darwin') for (const file of INTER_FILES) (renderer as { registerFont(bytes: Uint8Array): void }).registerFont(readFileSync(new URL(`../src/assets/fonts/${file}`, import.meta.url)))
  })
  return <div testId="text-ready" style={{ display: 'flex', gap: 28, padding: 16, width: '100%', height: '100%', backgroundColor: rgb(BACKGROUND) }}>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, width: 600 }}>
      {heading('UI font, 14/20')}
      {WEIGHTS.map(w => <text key={w} testId={`ui-${w}`} style={line(FONT_UI, 14, 20, w)}>{LADDER}</text>)}
      {heading('Inter Variable, 13/18')}
      {WEIGHTS.map(w => <text key={w} testId={`inter-${w}`} style={line(INTER, 13, 18, w)}>{LADDER}</text>)}
      {heading('Code face, 13/21.125')}
      <text testId="mono" style={line(FONT_MONO, MONO_SIZE, 21.125)}>{MONO}</text>
      <text testId="jbm" style={line('JetBrains Mono', MONO_SIZE, 21.125)}>{MONO}</text>
      <text testId="mono-probe" style={line(FONT_MONO, MONO_PROBE_SIZE, 32)}>{MONO_PROBE}</text>
      {heading('Inline code (rich editor, 0.833)')}
      <div style={{ display: 'flex', flexDirection: 'column', width: 420 }}>
        <RichEditor testId="editor" value={`\`${INLINE}\``} epoch={0} variant="page" readOnly images={null} />
      </div>
      {heading('Emoji and CJK, UI font 16/24')}
      <text testId="emoji" style={line(FONT_UI, 16, 24)}>{EMOJI}</text>
      <text testId="cjk" style={line(FONT_UI, 16, 24)}>{CJK}</text>
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {heading('Sizes: Inter · JetBrains Mono · UI font')}
      {SIZES.map(([size, lineHeight], i) => <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <text testId={`caps-${i}`} style={line(INTER, size, lineHeight)}>{CAPS}</text>
        <text testId={`mcaps-${i}`} style={line('JetBrains Mono', size, lineHeight)}>{CAPS}</text>
        <text testId={`usize-${i}`} style={line(FONT_UI, size, lineHeight)}>{`${size}/${lineHeight}`}</text>
      </div>)}
      {heading(`Wrapped, Inter 14/20 in ${WRAP_WIDTH}`)}
      <text testId="wrap" style={{ color: fg, fontFamily: INTER, fontSize: 14, lineHeight: 20, width: WRAP_WIDTH }}>{WRAP}</text>
    </div>
  </div>
}
// 1000 x 720 fits the Windows runner's 1024 x 768 screen, so every OS draws the same geometry.
render(<Lab />, { title: 'Text specimen', width: 1000, height: 720, focus: false })
