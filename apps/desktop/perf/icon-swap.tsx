/* eslint-disable react-refresh/only-export-components */
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"

import { Spinner } from "../src/components/kybern/bits"
import { IconSwap } from "../src/components/kybern/motion"
import { BrainIcon, CheckIcon, CopyIcon } from "../src/lib/kit/icons"
import "../src/index.css"

const root = createRoot(document.getElementById("root")!)
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
const check = (value: unknown, message: string): asserts value => { if (!value) throw new Error(message) }
const near = (a: number, b: number, tolerance = 0.5) => Math.abs(a - b) <= tolerance
const native = () => (window as unknown as { webkit: { messageHandlers: { bench: { postMessage: (text: string) => void } } } }).webkit.messageHandlers.bench

let thoughtComplete = true
let thoughtKey = 0
let copied = false

function Glyph({ name, children }: { name: string; children: React.ReactNode }) {
  return <span data-icon={name} className="inline-flex shrink-0">{children}</span>
}

function Scene() {
  return (
    <main className="p-8 text-foreground">
      <div data-fixture="thought" className="flex items-center gap-2">
        <span data-slot="thought" className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
          <IconSwap
            key={thoughtKey}
            active={thoughtComplete ? "b" : "a"}
            a={<Glyph name="spinner"><Spinner size={14} className="text-muted-foreground" /></Glyph>}
            b={<Glyph name="brain"><BrainIcon className="size-4" /></Glyph>}
          />
        </span>
        <span data-label="thought">{thoughtComplete ? "Thought" : "Thinking"}</span>
      </div>
      <button type="button" data-fixture="copy" aria-label={copied ? "Copied" : "Copy"} className="mt-6 inline-flex size-6 items-center justify-center" onClick={() => { copied = !copied; render() }}>
        <IconSwap
          active={copied ? "b" : "a"}
          a={<Glyph name="copy"><CopyIcon className="size-3.5" /></Glyph>}
          b={<Glyph name="check"><CheckIcon className="size-3.5 text-success" /></Glyph>}
        />
      </button>
    </main>
  )
}

function render() {
  flushSync(() => root.render(<Scene />))
}

function thoughtSwap() {
  return document.querySelector<HTMLElement>('[data-fixture="thought"] .t-icon-swap')!
}

function children(swap = thoughtSwap()) {
  return Array.from(swap.children) as HTMLElement[]
}

function icon(name: string, scope: ParentNode = document) {
  return scope.querySelector<HTMLElement>(`[data-icon="${name}"]`)
}

function setThought(complete: boolean, remount = false) {
  thoughtComplete = complete
  if (remount) thoughtKey++
  render()
}

function enableReducedMotionRules() {
  const changed: { rule: CSSMediaRule; media: string }[] = []
  const visit = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if (rule instanceof CSSMediaRule && rule.conditionText.replaceAll(" ", "").includes("prefers-reduced-motion:reduce")) {
        changed.push({ rule, media: rule.media.mediaText })
        rule.media.mediaText = "all"
      } else if ("cssRules" in rule) visit((rule as CSSGroupingRule).cssRules)
    }
  }
  for (const sheet of document.styleSheets) visit(sheet.cssRules)
  check(changed.length > 0, "No reduced-motion rules found")
  return () => { for (const { rule, media } of changed) rule.media.mediaText = media }
}

async function run() {
  document.documentElement.classList.add("dark")
  document.documentElement.dataset.windowMaterial = "opaque"
  document.documentElement.style.colorScheme = "dark"
  document.body.className = "m-0 bg-background font-ui"

  render()
  check(children().length === 1 && icon("brain", thoughtSwap()) && !icon("spinner", thoughtSwap()), "An initially settled Thought retained its hidden Spinner")

  setThought(false, true)
  await frame()
  const slot = document.querySelector<HTMLElement>('[data-slot="thought"]')!
  const label = document.querySelector<HTMLElement>('[data-label="thought"]')!
  const liveSlot = slot.getBoundingClientRect()
  const liveLabelX = label.getBoundingClientRect().x
  const spinner = icon("spinner", thoughtSwap())!
  const spinnerSvg = spinner.querySelector<SVGElement>("svg")!
  const spinnerRect = spinnerSvg.getBoundingClientRect()
  check(children().length === 1 && spinner && !icon("brain", thoughtSwap()), "Live Thinking did not mount only its Spinner")
  check(near(spinnerRect.width, 14) && near(spinnerRect.height, 14), "Thinking Spinner is not 14px")
  check(getComputedStyle(spinnerSvg).animationName !== "none" && spinnerSvg.getAnimations().some((animation) => animation.playState === "running"), "Visible Thinking Spinner is not running")
  const restingSpinner = children()[0]!
  const restingStyle = getComputedStyle(restingSpinner)
  check(Number(restingStyle.opacity) === 1 && restingStyle.transitionDuration !== "0s", "Live Thinking did not commit its resting icon style before the swap")

  setThought(true)
  const midChildren = children()
  check(midChildren.length === 2 && icon("spinner", thoughtSwap()) && icon("brain", thoughtSwap()), "Thought cross-blur did not retain both glyphs during the transition")
  const childTransitions = midChildren.map((child) => {
    void getComputedStyle(child).opacity
    return child.getAnimations().filter((animation): animation is CSSTransition => animation instanceof CSSTransition)
  })
  check(childTransitions.every((items) => items.some((transition) => transition.transitionProperty === "opacity")), "Thought cross-blur did not start both real CSS transitions")
  const transitions = childTransitions.flat()
  for (const transition of transitions) {
    transition.pause()
    const duration = transition.effect?.getComputedTiming().duration
    check(typeof duration === "number" && duration > 0, "Thought cross-blur transition had no duration")
    transition.currentTime = duration / 2
  }
  const midOpacities = midChildren.map((child) => Number(getComputedStyle(child).opacity))
  check(midOpacities.every((opacity) => opacity > 0.01 && opacity < 0.99), "Thought cross-blur had no intermediate transition")
  for (const transition of transitions) transition.play()
  await sleep(270)
  const settledSlot = slot.getBoundingClientRect()
  const brainRect = icon("brain", thoughtSwap())!.querySelector("svg")!.getBoundingClientRect()
  check(children().length === 1 && !icon("spinner", thoughtSwap()) && icon("brain", thoughtSwap()), "Exited Spinner remained mounted after the cross-blur")
  check(near(brainRect.width, 16) && near(brainRect.height, 16), "Settled Brain icon is not 16px")
  check(near(liveSlot.width, 20) && near(liveSlot.height, 20) && near(settledSlot.width, 20) && near(settledSlot.height, 20) && near(label.getBoundingClientRect().x, liveLabelX), "14px/16px glyph swap changed slot or text geometry")
  const activeStyle = getComputedStyle(children()[0]!)
  check(activeStyle.willChange.includes("transform") && activeStyle.willChange.includes("filter") && activeStyle.filter !== "none", "Resting active icon lost its original promotion styles")

  setThought(false, true)
  await frame()
  const originalSpinnerNode = children()[0]!
  setThought(true)
  await sleep(60)
  setThought(false)
  check(children().find((child) => child.dataset.active === "true") === originalSpinnerNode, "Rapid Thought reversal replaced the original keyed Spinner node")
  await sleep(310)
  check(children().length === 1 && children()[0] === originalSpinnerNode && !icon("brain", thoughtSwap()), "Rapid Thought reversal did not settle back to its original Spinner")

  const copyButton = document.querySelector<HTMLButtonElement>('[data-fixture="copy"]')!
  const copySwap = copyButton.querySelector<HTMLElement>(".t-icon-swap")!
  check(copySwap.children.length === 1 && icon("copy", copySwap) && !icon("check", copySwap), "Copy action did not start with only its Copy icon")
  copyButton.click()
  await frame()
  check(copySwap.children.length === 2 && icon("copy", copySwap) && icon("check", copySwap), "Copy/check cross-blur did not retain both glyphs")
  await sleep(270)
  check(copySwap.children.length === 1 && !icon("copy", copySwap) && icon("check", copySwap), "Copy action did not release its inactive Copy icon")
  copyButton.click()
  await sleep(310)
  check(copySwap.children.length === 1 && icon("copy", copySwap) && !icon("check", copySwap), "Copy action did not return cleanly to its Copy icon")

  const restoreMotion = enableReducedMotionRules()
  setThought(false, true)
  await frame()
  setThought(true)
  await frame()
  check(children().length === 2 && children().every((child) => getComputedStyle(child).transitionDuration === "0s"), "Reduced motion did not disable the icon cross-blur")
  await sleep(270)
  check(children().length === 1 && !icon("spinner", thoughtSwap()), "Reduced-motion swap did not release its inactive Spinner")
  restoreMotion()

  native().postMessage(JSON.stringify({ fixture: "icon-swap", pass: true, settledSpinnerUnmounted: true, liveSpinnerRunning: true, crossBlur: true, inactiveReleased: true, rapidReversalIdentity: true, stableGeometry: true, copyCheck: true, reducedMotion: true, activePromotionPreserved: true }))
}

run().catch((error) => native().postMessage(JSON.stringify({ fixture: "icon-swap", pass: false, error: String(error) })))
