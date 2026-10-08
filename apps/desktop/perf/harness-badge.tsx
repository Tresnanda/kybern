/* eslint-disable react-refresh/only-export-components */
import { createRoot } from "react-dom/client"
import { ProviderMark } from "../src/components/kybern/bits"
import { ProviderAvatarStack } from "../src/views/subagents/parts"
import { ThemeProviderContext } from "../src/components/theme-context"
import { buildThemeCssVariables, DEFAULT_THEME_STATE } from "../src/lib/kit/theme/theme.logic"
import type { ProviderKind } from "../src/protocol"
import "../src/index.css"
declare const __COLLAB_THEME__: "dark" | "light"
const theme = __COLLAB_THEME__
const kinds: ProviderKind[] = ["claude-code", "codex", "cursor", "opencode", "pi", "omp"]
document.documentElement.classList.toggle("dark", theme === "dark")
const tokens = buildThemeCssVariables({ codeThemeId: DEFAULT_THEME_STATE.codeThemeIds[theme], theme: DEFAULT_THEME_STATE.chromeThemes[theme] }, theme, { electron: true, isMac: true, systemUiFont: true })
for (const [key, value] of Object.entries(tokens.variables)) document.documentElement.style.setProperty(key, value as string)
document.body.style.background = "var(--background)"
document.body.style.color = "var(--foreground)"
const Single = ({ kind }: { kind: ProviderKind }) => (
  <span className="sa-avatar sa-avatar--single shrink-0" aria-hidden><ProviderMark kind={kind} size={12} className="size-3" /></span>
)
function Shell() {
  return (
    <ThemeProviderContext value={{ theme, translucent: false, setTheme: () => {}, setTranslucent: () => {} }}>
      <main data-badge-fixture className="flex flex-col gap-4 p-5 text-sm">
        <section aria-label="Single badges" className="flex items-center gap-3">{kinds.map((k) => <Single key={k} kind={k} />)}</section>
        <section aria-label="Group row" className="flex items-center gap-2.5"><ProviderAvatarStack kinds={kinds} /><span>6 subagents</span></section>
        <section aria-label="Group row, one harness" className="flex items-center gap-2.5"><ProviderAvatarStack kinds={["claude-code"]} /><span>1 subagent</span></section>
        <section aria-label="Large preview" className="flex items-center gap-3" style={{ zoom: 4 }}>{kinds.map((k) => <Single key={k} kind={k} />)}</section>
      </main>
    </ThemeProviderContext>
  )
}
createRoot(document.getElementById("root")!).render(<Shell />)
