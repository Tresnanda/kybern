// The small buttons in a run composer's tray.
import type { ReactNode } from "react"

import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/kit/tooltip"
import { ChevronDownIcon } from "@/lib/kit/icons"
import { cn } from "@/lib/utils"
import { TRAY_BUTTON_CLASS_NAME } from "./dockMotion"

export function TrayButton({ tip, onClick, disabled, children }: { tip: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<button type="button" className={TRAY_BUTTON_CLASS_NAME} disabled={disabled} onClick={onClick} />}>{children}</TooltipTrigger>
      <TooltipPopup side="top">{tip}</TooltipPopup>
    </Tooltip>
  )
}

export function HideButton({ onClick, tip = "Hide (Esc). Your draft stays." }: { onClick: () => void; tip?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<button type="button" aria-label="Hide the composer" className={cn(TRAY_BUTTON_CLASS_NAME, "px-1.5")} onClick={onClick} />}>
        <ChevronDownIcon className="size-3.5" aria-hidden />
      </TooltipTrigger>
      <TooltipPopup side="top">{tip}</TooltipPopup>
    </Tooltip>
  )
}
