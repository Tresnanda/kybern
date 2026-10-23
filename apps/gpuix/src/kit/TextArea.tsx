// The multi-line field: padding 9 / 10, at least 76 high, growing to `maxRows`. Same states as `TextField`. Replaces the PR review
// textarea, the question card's answer field and the environment Notes textarea.
import type { StyleDesc, TextareaProps } from '@gpuix/react'
import { useState } from 'react'
import { FONT_UI } from '../theme.ts'
import { useTheme } from '../ui.tsx'
import { FieldShell, type FieldSize } from './Field.tsx'

export interface TextAreaProps extends Omit<TextareaProps, 'value' | 'onChange' | 'style' | 'readOnly'> {
  label: string
  value: string
  onChange: (value: string) => void
  size?: FieldSize
  width?: number | `${number}%`
  invalid?: boolean
  disabled?: boolean
  style?: StyleDesc
  shell?: StyleDesc
  testId?: string
  onBlur?: () => void
}

export function TextArea({ label, value, onChange, size = 'md', width, invalid = false, disabled = false, minRows = 3, maxRows = 8, style, shell, testId, onBlur, onFocus, ...props }: TextAreaProps) {
  const t = useTheme()
  const [focused, setFocused] = useState(false)
  return (
    <FieldShell size={size} focused={focused} invalid={invalid} disabled={disabled} multiline width={width} style={shell}>
      <textarea
        {...props}
        testId={testId}
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        value={value}
        readOnly={disabled}
        minRows={minRows}
        maxRows={maxRows}
        theme={{ caret: t.text, textMuted: t.textPlaceholder, ...props.theme }}
        onChange={(e) => onChange(e.value ?? '')}
        onFocus={(e) => { setFocused(true); onFocus?.(e) }}
        onBlur={() => { setFocused(false); onBlur?.() }}
        style={{ flexGrow: 1, minWidth: 0, borderWidth: 0, fontFamily: FONT_UI, fontSize: size === 'lg' ? 14 : 13, color: disabled ? t.textTertiary : t.text, backgroundColor: 'rgba(0, 0, 0, 0)', ...style }}
      />
    </FieldShell>
  )
}
