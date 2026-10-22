import type { GpuixTheme } from '@gpuix/react'
import { over, type Theme, FONT_UI, FONT_MONO } from '../theme.ts'
import { alpha } from '../transcript/kit.tsx'
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
/** DiffView.tsx uses plain unified text; no word or syntax highlighting.
 * Callers must omit wordDiff. Native row virtualization remains enabled by scroll. */
export function desktopDiffTheme(t: Theme, fileHeaders = true, size = 13, options: { glass?: boolean } = {}): GpuixTheme {
  // Whole-window glass has no opaque colour to mix the rows into: the body is clear and the add/delete rows are translucent tints.
  const bg=options.glass?'rgba(0, 0, 0, 0)':t.v('--background')
  const mix=(color:string,amount:number)=>options.glass?alpha(color,amount):over(alpha(color,amount),bg)
  return {
    appearance:t.variant,bg,text:t.text,textMuted:t.textSecondary,textFaint:t.textTertiary,
    fontSans:FONT_UI,fontMono:FONT_MONO,border:t.borderLight,
    diffAdd:t.green,diffDel:t.red,diffHunkBg:mix(t.text,0.05),
    metrics:{diffTextSize:size,diffLineHeight:size*1.65,diffFileHeaderHeight:30,
      diffHunkHeaderHeight:size*1.65+4,diffBodyBottomPad:0,diffGutterWidth:29,
      diffMarkerWidth:size*0.602*1.5,diffAccentBarWidth:0,diffRowPaddingX:12},
    diff:{fileHeaders,notices:false,syntaxHighlight:false,horizontalScroll:true,tableLayout:true,showMoreBatch:600,scrollbarHeight:10,scrollbarColor:t.variant==='dark'?'rgba(255,255,255,0.07)':'rgba(0,0,0,0.1)',
      addBackground:mix(t.green,0.08),deleteBackground:mix(t.red,0.08),
      addGutterBackground:mix(t.green,0.12),deleteGutterBackground:mix(t.red,0.12),
      numberColor:alpha(t.textSecondary,0.45),textColor:t.text,gutterFont:FONT_UI,
      gutterTextSize:size,gutterPaddingRight:6,contentPaddingLeft:0,contextMarker:' ',deleteMarker:'-'}
  }
}
