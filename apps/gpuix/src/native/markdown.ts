import type { GpuixTheme } from '@gpuix/react'
/** Optional native Markdown controls. Pixels except ratios/weights. Defaults
 * preserve upstream styling; unknown/invalid colors retain their fallback. */
export interface MarkdownStyle {
  link?: { color?: string; underline?: 'none' | 'always' | 'hover'; weight?: number }
  strongWeight?: number
  nestedListMarkers?: boolean
  codeBorderWidth?: number
  codeHeaderBorderWidth?: number
  codeHeaderLineHeight?: number
  codeHeaderBackground?: string
  tableGrid?: boolean
  tableBorder?: string
  tableBorderWidth?: number
  tableHeaderRuleWidth?: number
  tableHeaderWeight?: number
  tableHeaderBackground?: string
  tablePaddingX?: number
  tablePaddingY?: number
  quoteBorderWidth?: number
  quoteBorder?: string
  quoteBackground?: string
  quoteText?: string
  quotePaddingLeft?: number
  quotePaddingRight?: number
  quotePaddingY?: number
  quoteGap?: number
  listIndent?: number
  listMarkerGap?: number
  listMarkerSize?: number
  /** Distance of a bullet disc's right edge from the text; ordered numbers use `listMarkerGap`. */
  listBulletGap?: number
  /** Margin above and below a thematic break, collapsed with its neighbours. */
  ruleMargin?: number
  listMarker?: string
  listItemGap?: number
  listChildGap?: number
  inlineCodePaddingY?: number
  inlineCodePaddingX?: number
  inlineCodeSizeRatio?: number
  headingSizes?: number[]
  headingLineHeights?: number[]
  headingWeights?: number[]
  headingMarginTops?: number[]
  headingFollowingGap?: number
  headingMarginTop?: number
  headingMarginBottom?: number
  codeWrap?: boolean
  codeHeader?: boolean
  codeBackground?: string
  codeBorder?: string
  /** Links whose URL starts with `prefix` lead with an icon (two placeholder characters reserve its room). */
  linkIcons?: { prefix: string; svg: string; color: string; textColor?: string; weight?: number }[]
  /** A live answer: the caret after the last text and the fading of its newest words. */
  stream?: MarkdownStream
}
export interface MarkdownStream {
  caret: boolean
  caretColor?: string
  /** The blink phase, driven by the app. */
  caretVisible: boolean
  /** Birth times (epoch ms) of the newest words, oldest first. */
  born: number[]
  fadeMs?: number
}
declare module '@gpuix/native/host' {
  interface GpuixTheme { markdown?: MarkdownStyle }
  /** Applied while a Finder file drag hovers the element. */
  interface StyleDesc { dragOver?: Omit<StyleDesc, 'hover' | 'active' | 'dragOver'> }
}

export type MarkdownTheme = GpuixTheme & {markdown?:MarkdownStyle}
export function withMarkdownStyle<T extends GpuixTheme>(theme:T,markdown:MarkdownStyle):T & {markdown:MarkdownStyle} { return {...theme,markdown} }

/** Transcript CSS uses rem=16px; Notes uses its computed note-size. */
export function transcriptMarkdownStyle(text: string, muted: string, border: string, codeSurface: string, textSize=14, codeSize=12): MarkdownStyle {
  return {strongWeight:500,nestedListMarkers:true,codeBorderWidth:0,codeHeaderBorderWidth:0,codeHeaderLineHeight:24,codeHeaderBackground:'transparent',tableGrid:true,tableBorder:border,tableBorderWidth:1,tableHeaderRuleWidth:1,tableHeaderWeight:700,tableHeaderBackground:'transparent',tablePaddingX:7.2,tablePaddingY:5.6,
    quoteBorderWidth:2,quoteBorder:border,quoteBackground:'transparent',quoteText:muted,quotePaddingLeft:12.8,quotePaddingRight:0,quotePaddingY:0,quoteGap:10.4,
    listIndent:20,listMarkerGap:5,listMarkerSize:4,listMarker:text,listItemGap:4,listChildGap:10.4,
    inlineCodePaddingX:5.6,inlineCodePaddingY:1.6,inlineCodeSizeRatio:codeSize/textSize,headingSizes:[1.75,1.55,1.35,1.2,1.1,1].map(n=>n*textSize),headingLineHeights:[1.75,1.55,1.35,1.2,1.1,1].map(n=>n*textSize*1.25),headingMarginTop:1.1,headingMarginBottom:0.35,
    codeWrap:false,codeBackground:codeSurface,codeBorder:'transparent'}
}
export function notesMarkdownStyle(fg: string, secondary: string, faint: string, fill: string, size=16.1538, marker=faint): MarkdownStyle {
  return {...transcriptMarkdownStyle(fg,secondary,faint,fill,size,size*0.833),
    strongWeight:600,quoteBorder:faint,quotePaddingLeft:14,quoteText:secondary,quoteGap:0.27*size,
    listIndent:1.4*size,listMarker:marker,listItemGap:0.27*size,listChildGap:0.27*size,
    inlineCodePaddingX:0.33*0.833*size,inlineCodePaddingY:0.13*0.833*size,inlineCodeSizeRatio:0.833,
    headingSizes:[17/15,17/15,1,1,1,1].map(n=>n*size),headingLineHeights:[17/15*1.3,17/15*1.3,1.45,1.45,1.45,1.45].map(n=>n*size),headingWeights:[650,600,600,600,600,600],headingMarginTops:[2.25,2,1.6],headingFollowingGap:0.53*size,headingMarginTop:2,headingMarginBottom:0,codeHeader:false,codeBackground:fill}
}
