import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { Integrations } from "../src/views/Integrations"
import { TerminalWorkspace } from "../src/views/Terminal"
import { ArtifactsPane } from "../src/views/Artifacts"
import { ThemeProviderContext } from "../src/components/theme-context"
import {
  buildThemeCssVariables,
  DEFAULT_THEME_STATE,
} from "../src/lib/kit/theme/theme.logic"
import { useStore } from "../src/state/store"
import { transport } from "./integrations-rpc"
import type { Thread } from "../src/protocol"
import "../src/index.css"

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))
function check(value: unknown, label: string): asserts value {
  if (!value) throw new Error(label)
}
async function waitFor(condition: () => unknown, label: string) {
  const until = performance.now() + 5000
  while (!condition() && performance.now() < until) await sleep(20)
  check(condition(), label)
}
function button(text: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (el) => el.textContent?.trim() === text
  )!
}
const root = createRoot(document.getElementById("root")!)
const thread: Thread = {
  id: "fixture",
  project_id: "project",
  title: "Artifacts",
  provider: { kind: "claude-code", instance: "default" },
  model: null,
  effort: null,
  permission_mode: "supervised",
  status: "idle",
  worktree: null,
  cwd: "/fixture",
  provider_session_id: null,
  pinned: false,
  created_at: "2026-09-09T00:00:00Z",
  updated_at: "2026-09-09T00:00:00Z",
  last_seq: 15,
}
let previewCount = 0
let isolation = false
window.addEventListener("message", (event) => {
  if (event.data?.fixture !== "kybern-artifact") return
  previewCount = event.data.count
  isolation = event.data.isolated === true && event.origin === "null"
})
export function LoginTerminal() {
  const hasLogin = useStore((s) => !!s.activeTerminalTab.fixture)
  return hasLogin ? (
    <div className="h-80">
      <TerminalWorkspace threadId="fixture" active />
    </div>
  ) : null
}
function writeInput(input: HTMLInputElement, text: string) {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )!.set!.call(input, text)
  input.dispatchEvent(new Event("input", { bubbles: true }))
}
async function run() {
  for (const variant of ["light", "dark"] as const) {
    document.documentElement.classList.toggle("dark", variant === "dark")
    const built = buildThemeCssVariables(
      {
        codeThemeId: DEFAULT_THEME_STATE.codeThemeIds[variant],
        theme: DEFAULT_THEME_STATE.chromeThemes[variant],
      },
      variant,
      { electron: true, isMac: true, systemUiFont: true }
    )
    for (const [key, value] of Object.entries(built.variables))
      document.documentElement.style.setProperty(key, value)
    useStore
      .getState()
      .set({
        connection: { state: "open" },
        terminalTabs: {},
        activeTerminalTab: {},
        projects: {
          project: {
            id: "project",
            name: "Fixture project",
            path: "/fixture",
            created_at: "2026-09-09T00:00:00Z",
          },
        },
        threads: { fixture: thread },
        selected: { kind: "thread", id: "fixture" },
      })
    flushSync(() =>
      root.render(
        <ThemeProviderContext
          value={{
            theme: variant,
            translucent: false,
            setTheme: () => {},
            setTranslucent: () => {},
          }}
        >
          <div
            key={variant}
            className="flex h-screen gap-8 bg-background p-6 text-foreground"
          >
            <section className="min-w-0 flex-1 overflow-y-auto">
              <h1 className="mb-4 text-lg">Connectors and plugins</h1>
              <Integrations />
              <LoginTerminal />
            </section>
            <section className="w-96">
              <ArtifactsPane threadId="fixture" active />
            </section>
          </div>
        </ThemeProviderContext>
      )
    )
    await waitFor(
      () => !!button("Show more") && !!button("Republish"),
      "Catalog and artifacts load"
    )
    check(
      document.querySelectorAll("h3").length === 41,
      "Catalog mounts 40 entries plus artifact"
    )
    const blocked = [...document.querySelectorAll("h3")].find(
      (el) => el.textContent === "Plugin 001"
    )!.parentElement!
    check(
      blocked.querySelectorAll("button").length === 0,
      "Admin-disabled plugin offers no mutations"
    )
    button("Show more").click()
    await waitFor(
      () => document.querySelectorAll("h3").length === 81,
      "Catalog can reveal more entries"
    )
    button("Install").click()
    await waitFor(
      () => transport.sent.some((r) => r.method === "integrations.change"),
      "Install forwards native action"
    )
    await waitFor(
      () => !!document.querySelector('[role="status"]'),
      "Install reports result"
    )
    button("Connectors").click()
    await waitFor(() => !!button("Sign in"), "Connector login is available")
    button("Sign in").click()
    await waitFor(
      () => useStore.getState().activeTerminalTab.fixture === "oauth-terminal",
      "OAuth opens its own terminal"
    )
    await waitFor(
      () => !!button("Sign in on auth.example.test"),
      "Sign-in URL appears from the existing terminal"
    )
    check(
      !transport.sent.some((r) => r.method === "terminals.create"),
      "Existing OAuth terminal is never recreated"
    )
    button("Sign in on auth.example.test").click()
    await waitFor(
      () =>
        transport.opened.some((url) =>
          url.startsWith("https://auth.example.test/")
        ),
      "Sign-in page opens explicitly"
    )
    writeInput(
      document.querySelector<HTMLInputElement>(
        '[aria-label="Sign-in redirect URL"]'
      )!,
      "http://localhost/callback?code=test"
    )
    await waitFor(
      () => !button("Complete sign-in").disabled,
      "Redirect is ready to submit"
    )
    button("Complete sign-in").click()
    await waitFor(
      () => transport.sent.some((r) => r.method === "terminals.input"),
      "Redirect is passed to native sign-in"
    )
    check(
      atob(
        (
          transport.sent.find((r) => r.method === "terminals.input")!
            .params as { data: string }
        ).data
      ) === "http://localhost/callback?code=test\r",
      "Redirect is sent intact with Enter"
    )
    await waitFor(
      () =>
        !document.querySelector<HTMLInputElement>(
          '[aria-label="Sign-in redirect URL"]'
        )!.value,
      "Successful sign-in submission clears secret input"
    )
    flushSync(() =>
      useStore.getState().set({ terminalTabs: {}, activeTerminalTab: {} })
    )
    await waitFor(() => !button("Refresh").disabled, "Login finishes")
    transport.fail = true
    button("Refresh").click()
    await waitFor(
      () => !!document.querySelector('[role="alert"]'),
      "Provider failure is visible"
    )
    transport.fail = false
    button("Refresh").click()
    await waitFor(
      () => !document.querySelector('[role="alert"]'),
      "Refresh recovers from provider failure"
    )
    button("Open in Claude").click()
    await waitFor(() => transport.opened.length > 0, "Hosted artifact opens")
    button("Republish").click()
    await waitFor(
      () => transport.sent.some((r) => r.method === "threads.send"),
      "Republish sends native request"
    )
    check(
      JSON.stringify(
        transport.sent.filter((r) => r.method === "threads.send").at(-1)
      ).includes("https://claude.ai/public/artifacts/fixture"),
      "Republish preserves hosted URL"
    )
    previewCount = 0
    button("Preview").click()
    await waitFor(
      () => previewCount === 1,
      "Isolated preview runs JavaScript under production CSP"
    )
    check(
      isolation,
      "Preview cannot read parent document and has opaque origin"
    )
    const frame = document.querySelector("iframe")!
    button("Source").click()
    await waitFor(
      () => !!document.querySelector("pre"),
      "Artifact source remains readable"
    )
    button("Preview").click()
    await sleep(100)
    check(
      document.querySelector("iframe") === frame,
      "Source toggle retains single-use preview"
    )
    frame.contentWindow!.postMessage({ action: "click" }, "*")
    await waitFor(
      () => previewCount === 2,
      "Interactive state remains usable after source toggle"
    )
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
    )
    await sleep(250)
    if (variant === "light") flushSync(() => root.render(null))
    else {
      button("Plugins").click()
      await sleep(100)
    }
  }
  report({
    pass: true,
    themes: ["light", "dark"],
    boundedCatalog: true,
    nativeMutation: true,
    oauthTerminal: true,
    republishPreservesUrl: true,
    isolatedInteractivePreview: true,
    sourceTogglePreservesState: true,
  })
}
function report(value: unknown) {
  ;(
    window as unknown as {
      webkit: {
        messageHandlers: { bench: { postMessage: (text: string) => void } }
      }
    }
  ).webkit.messageHandlers.bench.postMessage(JSON.stringify(value))
}
run().catch((error) => report({ pass: false, error: String(error) }))
