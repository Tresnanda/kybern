// Motion and sizes the run composers share: the task page's dock and the batch dock.
import { COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME } from "@/components/kit/chat/composerPickerStyles"
import { cn } from "@/lib/utils"

export const EASE_DRAWER = [0.32, 0.72, 0, 1] as const
export const EASE_OUT = [0.23, 1, 0.32, 1] as const

export const TRAY_BUTTON_CLASS_NAME = cn(COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME, "shrink-0 whitespace-nowrap")

/** The composer panel's motion: up 16px in 260ms, down 10px out in 160ms; opacity only when motion is reduced. */
export function panelMotion(reducedMotion: boolean | null) {
  return reducedMotion
    ? {
        initial: { opacity: 0 },
        animate: { opacity: 1, transition: { duration: 0.15 } },
        exit: { opacity: 0, pointerEvents: "none" as const, transition: { duration: 0.12 } },
      }
    : {
        initial: { opacity: 0, transform: "translateY(16px)" },
        animate: { opacity: 1, transform: "translateY(0px)", transition: { duration: 0.26, ease: EASE_DRAWER } },
        exit: { opacity: 0, transform: "translateY(10px)", pointerEvents: "none" as const, transition: { duration: 0.16, ease: EASE_OUT } },
      }
}

export function parentPath(path: string): string {
  const at = path.lastIndexOf("/")
  return at <= 0 ? path : "…/" + path.slice(path.slice(0, at).lastIndexOf("/") + 1, at)
}
