// Exercise the sidebar's actual context-menu primitive over busy content.
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { ContextMenu, ContextMenuContent, ContextMenuGroup, ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger } from "../src/components/ui/context-menu"
import { buildThemeCssVariables, DEFAULT_THEME_STATE } from "../src/lib/kit/theme/theme.logic"
import { PencilIcon, PinIcon, HandoffIcon, SquareSplitVertical, SquareSplitHorizontal, ArchiveIcon } from "../src/lib/kit/icons"
import "../src/index.css"

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const root = document.documentElement
function theme(variant: "dark" | "light") {
  root.classList.toggle("dark", variant === "dark")
  root.setAttribute("data-theme-variant", variant)
  const built = buildThemeCssVariables({ codeThemeId: DEFAULT_THEME_STATE.codeThemeIds[variant], theme: DEFAULT_THEME_STATE.chromeThemes[variant] }, variant, { electron: true, isMac: true, systemUiFont: true })
  for (const [key, value] of Object.entries(built.variables)) root.style.setProperty(key, value)
  root.style.setProperty("--app-opaque-content-surface", built.variables["--color-background-surface"]!)
}
let selected = ""
export function Demo() {
  return <div style={{ width: 550, padding: 24, background: "var(--color-background-panel)", minHeight: "100vh" }}>
    <ContextMenu>
      <ContextMenuTrigger render={<div id="menu-trigger" />}>
        {Array.from({ length: 20 }, (_, i) => <p key={i} style={{ fontSize: 22, padding: "12px 0", color: "var(--foreground)", whiteSpace: "nowrap" }}>{i % 2 ? "Investigate Kybern performance and rendering" : "Experimental content behind the context menu"}</p>)}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48 min-w-48">
        <ContextMenuGroup>
          <ContextMenuItem onClick={() => { selected = "rename" }}><PencilIcon /> Rename thread</ContextMenuItem>
          <ContextMenuItem><PinIcon /> Pin</ContextMenuItem>
          <ContextMenuItem><HandoffIcon /> Hand off to another agent</ContextMenuItem>
        </ContextMenuGroup>
        <ContextMenuSeparator />
        <ContextMenuGroup>
          <ContextMenuItem><SquareSplitVertical /> Open to the right</ContextMenuItem>
          <ContextMenuItem><SquareSplitHorizontal /> Open below</ContextMenuItem>
          <ContextMenuSub><ContextMenuSubTrigger>More actions</ContextMenuSubTrigger><ContextMenuSubContent><ContextMenuItem>Submenu action</ContextMenuItem></ContextMenuSubContent></ContextMenuSub>
        </ContextMenuGroup>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive"><ArchiveIcon /> Archive</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  </div>
}

async function run() {
  root.dataset.runtime = "electron"; root.dataset.platform = "macos"
  root.dataset.windowMaterial = "translucent"; root.dataset.fullTranslucency = ""
  theme("dark")
  flushSync(() => createRoot(document.getElementById("root")!).render(<Demo />))
  await sleep(100)
  const trigger = document.getElementById("menu-trigger")!
  trigger.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 95, clientY: 70 }))
  await sleep(350)
  const popup = document.querySelector<HTMLElement>('[data-slot="context-menu-content"]')
  if (!popup) throw new Error("Right click did not open the actual context menu")
  const filter = (el: Element) => getComputedStyle(el).getPropertyValue("-webkit-backdrop-filter")
  const results: Record<string, unknown> = {}
  let pass = true
  for (const variant of ["dark", "light"] as const) {
    theme(variant)
    await sleep(100)
    results[variant] = { background: getComputedStyle(popup).backgroundColor, filter: filter(popup), textOpacity: getComputedStyle(popup).opacity }
    pass &&= filter(popup).includes("blur(") && getComputedStyle(popup).opacity === "1"
  }
  theme("dark")
  const submenuTrigger = document.querySelector<HTMLElement>('[data-slot="context-menu-sub-trigger"]')!
  submenuTrigger.click()
  await sleep(300)
  const submenu = document.querySelector<HTMLElement>('[data-slot="context-menu-sub-content"]')
  results.submenu = submenu ? { filter: filter(submenu) } : null
  pass &&= !!submenu && filter(submenu).includes("blur(")
  theme("light")
  await sleep(50)
  results.lightSubmenu = submenu ? filter(submenu) : null
  pass &&= !!submenu && filter(submenu).includes("blur(")
  root.dataset.windowMaterial = "opaque"
  await sleep(250)
  results.opaqueFilter = filter(popup)
  pass &&= filter(popup) === "none"
  root.dataset.windowMaterial = "translucent"
  theme("dark")
  submenu?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
  await sleep(150)
  popup.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }))
  await sleep(50)
  const rename = popup.querySelector<HTMLElement>('[data-slot="context-menu-item"]')!
  const keyboardFocus = document.activeElement === rename
  rename.click()
  await sleep(200)
  results.keyboardFocus = keyboardFocus
  results.actionCloses = selected === "rename" && !document.querySelector('[data-slot="context-menu-content"]')
  pass &&= keyboardFocus && !!results.actionCloses
  // Keep the two popups visible for an optional native screenshot.
  trigger.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 95, clientY: 70 }))
  await sleep(180)
  document.querySelector<HTMLElement>('[data-slot="context-menu-sub-trigger"]')?.click()
  await sleep(180)
  const native = window as unknown as { webkit: { messageHandlers: { bench: { postMessage: (text: string) => void } } } }
  native.webkit.messageHandlers.bench.postMessage(JSON.stringify({ ...results, selected, pass }))
}
run().catch((error) => {
  const native = window as unknown as { webkit: { messageHandlers: { bench: { postMessage: (text: string) => void } } } }
  native.webkit.messageHandlers.bench.postMessage(JSON.stringify({ pass: false, error: String(error) }))
})
