// `<rich-editor>`: the native formatted editor (native/patches/rich_editor.rs).
import type { Props } from '@gpuix/react'

interface RichEditorHostProps extends Props {
  /** `{ blocks }` JSON, applied when `docEpoch` changes. */
  doc?: string
  docEpoch?: number
  theme?: Record<string, string | number | boolean>
  placeholder?: string
  readOnly?: boolean
  interceptKeys?: string[]
  /** Live task references: id → { key, status, statusLabel, state }. */
  tasks?: Record<string, { key: string; status: string; statusLabel: string; state: string }>
  /** Task key → id, so a typed or pasted key becomes a reference. */
  taskKeys?: Record<string, string>
  /** SVG glyphs by name (task statuses, `pending`, the checklist `tick`). */
  glyphs?: Record<string, { svg: string; color: string }>
}

declare module '@gpuix/react/jsx-runtime' {
  namespace JSX {
    interface IntrinsicElements {
      'rich-editor': RichEditorHostProps
    }
  }
}
declare module '@gpuix/react/jsx-dev-runtime' {
  namespace JSX {
    interface IntrinsicElements {
      'rich-editor': RichEditorHostProps
    }
  }
}
