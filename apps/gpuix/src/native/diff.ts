import type { GpuixTheme } from '@gpuix/react'
import { over, type Theme, FONT_UI, FONT_MONO, MONO_ADVANCE } from '../theme.ts'
import { alpha } from '../transcript/kit.tsx'
import { diffSyntaxTheme } from './syntaxPalette.ts'
export interface DiffStyle {
  fileHeaders?: boolean
  notices?: boolean
  syntaxHighlight?: boolean
  horizontalScroll?: boolean
  tableLayout?: boolean
  showMoreBatch?: number
  gutterDigitWidth?: number
  scrollbarHeight?: number
  scrollbarColor?: string
  addBackground?: string
  deleteBackground?: string
  addGutterBackground?: string
  deleteGutterBackground?: string
  numberColor?: string
  textColor?: string
  gutterFont?: string
  gutterTextSize?: number
  gutterPaddingRight?: number
  contentPaddingLeft?: number
  contextMarker?: string
  deleteMarker?: string
}
declare module '@gpuix/native/host' { interface GpuixTheme { diff?: DiffStyle } }
/** Plain unified text unless `syntax` is set: that turns the native per-file Syntect highlighting on (language from the
 * `+++ b/path` header) with the One Dark/One Light palette, only for callers that ask (the Pull requests Changes view).
 * Callers must omit wordDiff. Native row virtualization remains enabled by scroll. */
export function desktopDiffTheme(t: Theme, fileHeaders = true, size = 13, options: { glass?: boolean; syntax?: boolean } = {}): GpuixTheme {
  // Whole-window glass has no opaque colour to mix the rows into: the body is clear and the add/delete rows are translucent tints.
  const bg=options.glass?'rgba(0, 0, 0, 0)':t.v('--background')
  const mix=(color:string,amount:number)=>options.glass?alpha(color,amount):over(alpha(color,amount),bg)
  const tints=[0,0.08,0.12].flatMap(a=>[t.green,t.red].map(c=>over(alpha(c,a),t.v('--background'))))
  const syntax=options.syntax?diffSyntaxTheme(t.variant,[...tints,over(alpha(t.text,0.05),t.v('--background'))],t.contrast):undefined
  return {
    appearance:t.variant,bg,text:t.text,textMuted:t.textSecondary,textFaint:t.textTertiary,
    fontSans:FONT_UI,fontMono:FONT_MONO,border:t.borderLight,
    ...(syntax?{syntax}:{}),
    diffAdd:t.green,diffDel:t.red,diffHunkBg:mix(t.text,0.05),
    metrics:{diffTextSize:size,diffLineHeight:size*1.65,diffFileHeaderHeight:30,
      diffHunkHeaderHeight:size*1.65+4,diffBodyBottomPad:0,diffGutterWidth:29,
      diffMarkerWidth:size*MONO_ADVANCE*1.5,diffAccentBarWidth:0,diffRowPaddingX:12},
    diff:{fileHeaders,notices:false,syntaxHighlight:options.syntax===true,horizontalScroll:true,tableLayout:true,showMoreBatch:600,scrollbarHeight:10,scrollbarColor:t.variant==='dark'?'rgba(255,255,255,0.07)':'rgba(0,0,0,0.1)',
      addBackground:mix(t.green,0.08),deleteBackground:mix(t.red,0.08),
      addGutterBackground:mix(t.green,0.12),deleteGutterBackground:mix(t.red,0.12),
      numberColor:alpha(t.textSecondary,0.45),textColor:t.text,gutterFont:FONT_UI,
      gutterTextSize:size,gutterPaddingRight:6,contentPaddingLeft:0,contextMarker:' ',deleteMarker:'-'}
  }
}
