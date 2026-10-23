// The multi-line field: padding 9 / 10, at least 76 high, growing to `maxRows`. Same states as `TextField`. Replaces the PR review
// textarea, the question card's answer field and the environment Notes textarea.
import type { StyleDesc, TextareaProps } from '@gpuix/react'
import { useState } from 'react'
import { FONT_UI } from '../theme.ts'
import { Label, useTheme } from '../ui.tsx'
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
  /** No box at all: the text only (a row that is itself the field, like a question's free answer). */
  bare?: boolean
}

export function TextArea({ label, value, onChange, size = 'md', width, invalid = false, disabled = false, bare = false, minRows = 3, maxRows = 8, style, shell, testId, onBlur, onFocus, placeholder, ...props }: TextAreaProps) {
  const t = useTheme()
  const [focused, setFocused] = useState(false)
  const fontSize = typeof style?.fontSize === 'number' ? style.fontSize : size === 'lg' ? 14 : 13
  return (
    <FieldShell size={size} focused={focused} invalid={invalid} disabled={disabled} bare={bare} multiline width={width} style={bare ? { minHeight: 0, paddingTop: 0, paddingBottom: 0, ...shell } : shell}>
      {/* The theme's placeholder colour, as `TextField` paints it (the native one is a fixed grey). */}
      <div style={{ position: 'relative', display: 'flex', flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
        {placeholder && !value && (
          <div testId={testId ? `${testId}-placeholder` : undefined} style={{ position: 'absolute', top: 0, left: 0, right: 0, display: 'flex', pointerEvents: 'none' }}>
            <Label color={t.textPlaceholder} size={fontSize} font={FONT_UI} truncate>{placeholder}</Label>
          </div>
        )}
        <textarea
          {...props}
          testId={testId}
          tabIndex={disabled ? -1 : 0}
          aria-label={label}
          value={value}
          readOnly={disabled}
          minRows={minRows}
          maxRows={maxRows}
          onChange={(e) => onChange(e.value ?? '')}
          onFocus={(e) => { setFocused(true); onFocus?.(e) }}
          onBlur={() => { setFocused(false); onBlur?.() }}
          style={{ flexGrow: 1, minWidth: 0, borderWidth: 0, fontFamily: FONT_UI, fontSize, color: disabled ? t.textTertiary : t.text, backgroundColor: 'rgba(0, 0, 0, 0)', ...style }}
        />
      </div>
    </FieldShell>
  )
}
