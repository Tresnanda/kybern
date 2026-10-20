import type { Theme } from '../theme.ts'
import type { VisualTheme } from '../../../../packages/kybern-client/src/visuals.ts'
// visualFrameSupport.ts: same active desktop tokens, with the transcript surface.
export function visualTheme(t: Theme): VisualTheme {
  const variables = Object.fromEntries(Object.keys(t.raw).filter(key => /^--(background|foreground|card|popover|secondary|muted|border|input|ring|primary|accent|destructive|warning|success|info|radius)(-|$)/.test(key)).map(key => [key, t.v(key)]))
  Object.assign(variables, { '--background': t.surface, '--foreground': t.text, '--accent': t.link, '--chart-1': t.link, '--font-sans': 'system-ui,sans-serif', '--font-mono': 'Menlo,monospace', '--code-background': t.codeSurface, '--code-foreground': t.text })
  const colors = t.variant === 'dark' ? ['#2dd4bf', '#fbbf24', '#c084fc', '#fb7185', '#a3e635'] : ['#0d9488', '#d97706', '#9333ea', '#e11d48', '#65a30d']
  colors.forEach((value, index) => variables[`--chart-${index + 2}`] = value)
  return { appearance: t.variant, variables }
}
