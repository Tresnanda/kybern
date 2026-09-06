import * as React from "react"

export type Theme = "dark" | "light" | "system"

export type ThemeProviderState = {
  translucent: boolean
  setTranslucent: (enabled: boolean) => void
  theme: Theme
  setTheme: (theme: Theme) => void
}

export const THEME_VALUES: Theme[] = ["dark", "light", "system"]

export function isTheme(value: string | null): value is Theme {
  return value !== null && THEME_VALUES.includes(value as Theme)
}

export const ThemeProviderContext = React.createContext<ThemeProviderState | undefined>(undefined)

export function useTheme() {
  const context = React.useContext(ThemeProviderContext)

  if (context === undefined) {
    throw new Error("useTheme must be used within a ThemeProvider")
  }

  return context
}
