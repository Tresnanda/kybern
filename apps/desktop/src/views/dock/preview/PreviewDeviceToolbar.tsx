import { useEffect, useRef, useState } from "react"

import { ComposerPickerMenuPopup } from "@/components/kit/chat/ComposerPickerMenuPopup"
import { Input } from "@/components/kit/input"
import { Menu, MenuGroup, MenuGroupLabel, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@/components/kit/menu"
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/kit/tooltip"
import { ChevronsUpDownIcon, DeviceRotateIcon, XIcon } from "@/lib/kit/icons"
import { cn } from "@/lib/utils"
import type { ThreadId } from "@/protocol"
import { previewEnvironment } from "@/state/previewSession"
import { usePreviewSurface } from "@/state/previewSurface"
import { useStore, type PreviewViewport } from "@/state/store"
import {
  isViewportSizeValid,
  parseViewportField,
  RESPONSIVE_PRESET_ID,
  rotateViewport,
  VIEWPORT_PRESETS,
  viewportPreset,
  type ViewportGroup,
} from "../../../../../../packages/kybern-client/src/previewViewport"
import { PreviewAction } from "../PreviewPanel"
import { rememberDevicePreset } from "./deviceViewport"

type Device = Extract<PreviewViewport, { mode: "device" }>

const GROUPS: { id: ViewportGroup; label: string }[] = [
  { id: "phone", label: "Phone" },
  { id: "tablet", label: "Tablet" },
  { id: "desktop", label: "Desktop" },
]

/** The 32px device row under the chrome row: preset, W × H, rotate, fitted scale, hide. */
export function PreviewDeviceToolbar({ threadId, viewport, paneWidth }: { threadId: ThreadId; viewport: Device; paneWidth: number }) {
  const scale = usePreviewSurface((s) => s.scale.dock)
  const selected = viewport.presetId ?? RESPONSIVE_PRESET_ID
  const label = viewport.presetId ? viewportPreset(viewport.presetId)?.label ?? "Responsive" : "Responsive"
  const environment = previewEnvironment().name
  const set = (next: Device) => useStore.getState().setPreviewViewport(threadId, next)

  const choose = (id: string) => {
    if (id === RESPONSIVE_PRESET_ID) {
      set({ ...viewport, presetId: null })
      return
    }
    const preset = viewportPreset(id)
    if (!preset) return
    rememberDevicePreset(environment, preset.id)
    set({ mode: "device", presetId: preset.id, width: preset.w, height: preset.h })
  }
  const rotate = () => {
    const next = rotateViewport({ w: viewport.width, h: viewport.height })
    set({ ...viewport, width: next.w, height: next.h })
  }

  return (
    <div
      role="toolbar"
      aria-label="Device"
      data-preview-device-toolbar
      className="chat-surface-divider flex h-8 shrink-0 items-center gap-1 overflow-x-auto bg-[var(--color-background-surface)] px-2 font-system-ui [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <Menu>
        <MenuTrigger
          render={
            <button
              type="button"
              aria-label="Device preset"
              className={cn(
                "press flex h-6 shrink-0 items-center justify-between gap-1 rounded-md bg-[var(--color-background-button-secondary)] px-2 text-[11px] font-medium text-foreground/90 outline-none hover:bg-[var(--color-background-button-secondary-hover)] focus-visible:ring-1 focus-visible:ring-ring",
                paneWidth >= 440 ? "w-36" : "w-24",
              )}
            />
          }
        >
          <span className="min-w-0 truncate">{label}</span>
          <ChevronsUpDownIcon className="size-3 shrink-0 opacity-60" />
        </MenuTrigger>
        <ComposerPickerMenuPopup align="start" side="bottom" className="w-60">
          <MenuRadioGroup value={selected} onValueChange={(value) => choose(String(value))}>
            <MenuGroup>
              <MenuRadioItem value={RESPONSIVE_PRESET_ID}>Responsive</MenuRadioItem>
            </MenuGroup>
            {GROUPS.map((group) => (
              <MenuGroup key={group.id}>
                <MenuGroupLabel>{group.label}</MenuGroupLabel>
                {VIEWPORT_PRESETS.filter((preset) => preset.group === group.id).map((preset) => (
                  <MenuRadioItem
                    key={preset.id}
                    value={preset.id}
                    trailing={<span className="text-muted-foreground tabular-nums">{preset.w} × {preset.h}</span>}
                  >
                    {preset.label}
                  </MenuRadioItem>
                ))}
              </MenuGroup>
            ))}
          </MenuRadioGroup>
        </ComposerPickerMenuPopup>
      </Menu>

      <div className="flex shrink-0 items-center gap-1">
        <SizeField label="Width" value={viewport.width} other={viewport.height} axis="w" onCommit={(width) => set({ ...viewport, presetId: null, width })} />
        <span aria-hidden className="text-[11px] text-muted-foreground/60">×</span>
        <SizeField label="Height" value={viewport.height} other={viewport.width} axis="h" onCommit={(height) => set({ ...viewport, presetId: null, height })} />
      </div>

      <PreviewAction label="Rotate" onClick={rotate}>
        <DeviceRotateIcon />
      </PreviewAction>

      <span className="ml-auto flex shrink-0 items-center gap-1">
        {scale !== undefined && (
          <Tooltip>
            <TooltipTrigger render={<span className="text-[11px] tabular-nums text-muted-foreground/70" />}>{scale}%</TooltipTrigger>
            <TooltipPopup side="bottom">Scaled to fit the panel</TooltipPopup>
          </Tooltip>
        )}
        <PreviewAction label="Hide device toolbar" onClick={() => useStore.getState().setPreviewViewport(threadId, { mode: "fill" })}>
          <XIcon />
        </PreviewAction>
      </span>
    </div>
  )
}

/** One numeric field: commits on Enter or blur, reverts and says why when the size is out of range. */
function SizeField({ label, value, other, axis, onCommit }: { label: string; value: number; other: number; axis: "w" | "h"; onCommit: (value: number) => void }) {
  const [text, setText] = useState(String(value))
  const [invalid, setInvalid] = useState(false)
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setText(String(value))
  }, [value])
  useEffect(() => {
    if (!invalid) return
    const id = window.setTimeout(() => setInvalid(false), 1600)
    return () => window.clearTimeout(id)
  }, [invalid])

  const commit = () => {
    const parsed = parseViewportField(text)
    const ok = parsed !== null && (axis === "w" ? isViewportSizeValid(parsed, other) : isViewportSizeValid(other, parsed))
    if (!ok) {
      setText(String(value))
      setInvalid(true)
      return
    }
    if (parsed !== value) onCommit(parsed)
    setText(String(parsed))
  }

  return (
    <Tooltip open={invalid}>
      <TooltipTrigger render={<span className="inline-flex" />}>
        <Input
          variant="soft"
          aria-label={label}
          aria-invalid={invalid || undefined}
          inputMode="numeric"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onFocus={() => { focused.current = true }}
          onBlur={() => { focused.current = false; commit() }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              commit()
            } else if (event.key === "Escape") {
              setText(String(value))
            }
          }}
          className="h-6 !min-h-6 w-14 rounded-md sm:!min-h-6 [&_input]:px-1.5 [&_input]:py-0 [&_input]:text-center [&_input]:text-[11px] [&_input]:tabular-nums"
          nativeInput
        />
      </TooltipTrigger>
      <TooltipPopup side="bottom">Use 240–3840</TooltipPopup>
    </Tooltip>
  )
}
