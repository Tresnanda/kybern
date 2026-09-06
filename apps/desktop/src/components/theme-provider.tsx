import * as React from "react"

import { applyAppearance } from "@/lib/kit/applyTheme"
import { isTauri } from "@/lib/tauri"
import { isTheme, ThemeProviderContext, type Theme } from "@/components/theme-context"

type ResolvedTheme = "dark" | "light"

type ThemeProviderProps = {
  children: React.ReactNode
  defaultTheme?: Theme
  storageKey?: string
  disableTransitionOnChange?: boolean
}

const COLOR_SCHEME_QUERY = "(prefers-color-scheme: dark)"

function getSystemTheme(): ResolvedTheme {
  if (window.matchMedia(COLOR_SCHEME_QUERY).matches) {
    return "dark"
  }

  return "light"
}

function disableTransitionsTemporarily() {
  const style = document.createElement("style")
  style.appendChild(
    document.createTextNode(
      "*,*::before,*::after{-webkit-transition:none!important;transition:none!important}"
    )
  )
  document.head.appendChild(style)

  return () => {
    window.getComputedStyle(document.body)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        style.remove()
      })
    })
  }
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false
  }

  if (target.isContentEditable) {
    return true
  }

  const editableParent = target.closest(
    "input, textarea, select, [contenteditable='true']"
  )
  if (editableParent) {
    return true
  }

  return false
}

async function syncWindowAppearance(theme: Theme): Promise<void> {
  if (!isTauri()) return
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window")
    // Passing null does not reliably return the window to the system look once an
    // explicit appearance was set, so resolve "system" ourselves.
    const resolved = theme === "system" ? getSystemTheme() : theme
    await getCurrentWindow().setTheme(resolved)
  } catch {
    // Window appearance is best effort; the CSS theme already applied.
  }
}

export function ThemeProvider({
  children,
  defaultTheme = "system",
  storageKey = "theme",
  disableTransitionOnChange = true,
  ...props
}: ThemeProviderProps) {
  const [translucent, setTranslucentState] = React.useState(() => localStorage.getItem("kybern.translucent") === "true")
  const setTranslucent = React.useCallback((enabled: boolean) => {
    localStorage.setItem("kybern.translucent", String(enabled))
    setTranslucentState(enabled)
  }, [])
  React.useLayoutEffect(() => {
    document.documentElement.toggleAttribute("data-full-translucency", translucent)
  }, [translucent])

  const [theme, setThemeState] = React.useState<Theme>(() => {
    const storedTheme = localStorage.getItem(storageKey)
    if (isTheme(storedTheme)) {
      return storedTheme
    }

    return defaultTheme
  })

  const setTheme = React.useCallback(
    (nextTheme: Theme) => {
      localStorage.setItem(storageKey, nextTheme)
      setThemeState(nextTheme)
    },
    [storageKey]
  )

  const appliedOnce = React.useRef(false)
  const applyTheme = React.useCallback(
    (nextTheme: Theme) => {
      const restoreTransitions = disableTransitionOnChange
        ? disableTransitionsTemporarily()
        : null

      // The kit's runtime tokens (color math, density, typography) live on <html>.
      // After the first paint, flip palettes inside a view transition so the
      // whole window cross-fades instead of snapping (per-element transitions
      // stay disabled above; this is one document-level fade).
      const doc = document as Document & { startViewTransition?: (update: () => void) => unknown }
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      if (appliedOnce.current && doc.startViewTransition && !reduceMotion) {
        doc.startViewTransition(() => applyAppearance(nextTheme))
      } else {
        applyAppearance(nextTheme)
      }
      appliedOnce.current = true
      // The macOS window material (sidebar vibrancy) follows the NSWindow appearance,
      // not our CSS, so a light theme on a dark desktop kept a dark sidebar.
      void syncWindowAppearance(nextTheme)

      if (restoreTransitions) {
        restoreTransitions()
      }
    },
    [disableTransitionOnChange]
  )

  React.useEffect(() => {
    applyTheme(theme)

    if (theme !== "system") {
      return undefined
    }

    const mediaQuery = window.matchMedia(COLOR_SCHEME_QUERY)
    const handleChange = () => {
      applyTheme("system")
    }

    mediaQuery.addEventListener("change", handleChange)

    return () => {
      mediaQuery.removeEventListener("change", handleChange)
    }
  }, [theme, applyTheme])

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) {
        return
      }

      if (event.metaKey || event.ctrlKey || event.altKey) {
        return
      }

      if (isEditableTarget(event.target)) {
        return
      }

      if (event.key.toLowerCase() !== "d") {
        return
      }

      setThemeState((currentTheme) => {
        const nextTheme =
          currentTheme === "dark"
            ? "light"
            : currentTheme === "light"
              ? "dark"
              : getSystemTheme() === "dark"
                ? "light"
                : "dark"

        localStorage.setItem(storageKey, nextTheme)
        return nextTheme
      })
    }

    window.addEventListener("keydown", handleKeyDown)

    return () => {
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [storageKey])

  React.useEffect(() => {
    const handleStorageChange = (event: StorageEvent) => {
      if (event.storageArea !== localStorage) {
        return
      }

      if (event.key !== storageKey) {
        return
      }

      if (isTheme(event.newValue)) {
        setThemeState(event.newValue)
        return
      }

      setThemeState(defaultTheme)
    }

    window.addEventListener("storage", handleStorageChange)

    return () => {
      window.removeEventListener("storage", handleStorageChange)
    }
  }, [defaultTheme, storageKey])

  const value = React.useMemo(
    () => ({
      theme,
      setTheme,
      translucent,
      setTranslucent,
    }),
    [theme, setTheme, translucent, setTranslucent]
  )

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  )
}
