import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { ThemeProvider } from "../src/components/theme-provider"
import { useTheme } from "../src/components/theme-context"
import { vibrancyCalls } from "./theme-provider-tauri"

const bridge = (window as unknown as { webkit: { messageHandlers: { bench: { postMessage(value: string): void } } } }).webkit.messageHandlers.bench
const report = (value: Record<string, unknown>) => bridge.postMessage(JSON.stringify(value))

function Probe() {
  const { translucent, setTranslucent } = useTheme()
  return <button type="button" onClick={() => setTranslucent(!translucent)}>{translucent ? "Disable full translucency" : "Enable full translucency"}</button>
}

async function run() {
  localStorage.setItem("fixture.theme", "dark")
  localStorage.setItem("kybern.translucent", "false")
  const root = createRoot(document.getElementById("root")!)
  flushSync(() => root.render(<ThemeProvider defaultTheme="dark" storageKey="fixture.theme"><Probe /></ThemeProvider>))
  const initialAttribute = document.documentElement.hasAttribute("data-full-translucency")
  const button = document.querySelector<HTMLButtonElement>("button")!
  flushSync(() => button.click())
  const enabledAttribute = document.documentElement.hasAttribute("data-full-translucency")
  const enabledStored = localStorage.getItem("kybern.translucent")
  flushSync(() => button.click())
  const disabledAttribute = document.documentElement.hasAttribute("data-full-translucency")
  const disabledStored = localStorage.getItem("kybern.translucent")
  await Promise.resolve()
  report({
    pass: !initialAttribute && enabledAttribute && !disabledAttribute && enabledStored === "true" && disabledStored === "false" && vibrancyCalls.length === 0,
    initialAttribute,
    enabledAttribute,
    disabledAttribute,
    enabledStored,
    disabledStored,
    vibrancyCalls,
  })
  flushSync(() => root.unmount())
}

run().catch((error) => report({ pass: false, error: String(error), vibrancyCalls }))
