// Headless-WebKit probe for the desktop motion work. Connects the Vite frontend to the scratch
// daemon (scratch.sh + seed.sh) and records every animation an interaction starts: target,
// property, duration, easing. Also samples frame intervals, long tasks and live animation counts.
//
//   import { open, probe, thread, frames, runningAnimations } from "./probe-lib.mjs"
//
// Env: DATA (scratch dir), PORT (daemon, 4368), VITE_PORT (5368), OUT (screenshots),
// PLAYWRIGHT_CORE (path of playwright-core/index.mjs).
import { appendFileSync, mkdirSync, readFileSync } from "node:fs"

const CORE = process.env.PLAYWRIGHT_CORE || "/Users/mymac/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs"
const { webkit } = await import(CORE)

export const DATA = process.env.DATA || "/tmp/kybern-motion-scratch"
export const OUT = process.env.OUT || `${DATA}/shots`
mkdirSync(OUT, { recursive: true })
const token = readFileSync(`${DATA}/daemon.token`, "utf8").trim()
export const APP = `http://localhost:${process.env.VITE_PORT || 5368}/?url=${encodeURIComponent(`ws://127.0.0.1:${process.env.PORT || 4368}/ws`)}&token=${encodeURIComponent(token)}`

export async function open({ scheme = "dark", width = 1440, height = 900, reduced = false, scale = 2 } = {}) {
  const browser = await webkit.launch()
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, colorScheme: scheme, reducedMotion: reduced ? "reduce" : "no-preference" })
  const page = await ctx.newPage()
  page.on("pageerror", (e) => console.error("pageerror", e.message.slice(0, 200)))
  await page.addInitScript(() => {
    window.__anims = []
    const describe = (el) => {
      if (!el || !el.tagName) return String(el)
      const cls = (el.getAttribute("class") || "").split(/\s+/).filter(Boolean).slice(0, 6).join(".")
      return `${el.tagName.toLowerCase()}${cls ? "." + cls : ""}`.slice(0, 160)
    }
    const seen = new WeakSet()
    const scan = () => {
      for (const a of document.getAnimations()) {
        if (seen.has(a)) continue
        seen.add(a)
        const t = a.effect?.getTiming?.() || {}
        const kf = a.effect?.getKeyframes?.() || []
        const props = [...new Set(kf.flatMap((k) => Object.keys(k).filter((p) => !["offset", "easing", "composite", "computedOffset"].includes(p))))]
        window.__anims.push({
          at: Math.round(performance.now()), kind: a.constructor.name, name: a.animationName || a.transitionProperty || "", props,
          duration: t.duration, delay: t.delay, easing: t.easing,
          kfEasing: kf.map((k) => k.easing).filter((e) => e && e !== "linear").slice(0, 1)[0],
          iterations: t.iterations, target: describe(a.effect?.target), pseudo: a.effect?.pseudoElement || undefined,
        })
      }
      requestAnimationFrame(scan)
    }
    requestAnimationFrame(scan)
  })
  await page.goto(APP)
  await page.waitForTimeout(2500)
  return { browser, ctx, page }
}

/** Open a thread from the sidebar by (part of) its title. */
export async function thread(page, title) {
  await page.getByText(title, { exact: false }).first().click()
  await page.waitForTimeout(900)
}

export function summarize(anims) {
  const groups = new Map()
  for (const a of anims) {
    const key = `${a.kind}|${a.name}|${a.props.join(",")}|${a.duration}|${a.easing}${a.kfEasing ? "/" + a.kfEasing : ""}|${a.target}${a.pseudo || ""}${a.iterations === Infinity ? "|loop" : ""}`
    groups.set(key, (groups.get(key) || 0) + 1)
  }
  return [...groups].map(([k, n]) => `${n}× ${k}`)
}

/** Run an interaction and record what animated during the next `window` ms; `mid` screenshots at ~60 ms. */
export async function probe(page, label, action, { window = 700, shot = true, mid = false, quiet = false } = {}) {
  await page.evaluate(() => { window.__anims = [] })
  const t0 = await page.evaluate(() => performance.now())
  await action()
  if (mid) {
    await page.waitForTimeout(60)
    await page.screenshot({ path: `${OUT}/${label}-mid.png` })
  }
  await page.waitForTimeout(window)
  const anims = await page.evaluate(() => window.__anims)
  const rel = anims.map((a) => ({ ...a, at: Math.round(a.at - t0) })).filter((a) => a.iterations !== Infinity || a.at >= -50)
  if (shot) await page.screenshot({ path: `${OUT}/${label}.png` })
  const summary = summarize(rel)
  appendFileSync(`${OUT}/probe-log.jsonl`, JSON.stringify({ label, count: rel.length, summary }) + "\n")
  if (!quiet) {
    console.log(`\n## ${label}: ${rel.length} animations`)
    for (const s of summary) console.log("  " + s)
  }
  return rel
}

/** Animations running right now, as `name duration target`. */
export async function runningAnimations(page, { loopsOnly = false } = {}) {
  return page.evaluate((loopsOnly) => document.getAnimations()
    .filter((a) => a.playState === "running" && (!loopsOnly || a.effect?.getTiming().iterations === Infinity))
    .map((a) => `${a.animationName || a.transitionProperty} ${a.effect.getTiming().duration}ms ${(a.effect.target?.getAttribute?.("class") || a.effect.target?.tagName || "").slice(0, 80)}`), loopsOnly)
}

/**
 * Frame intervals and long tasks while `action()` runs (typically a scroll or a wait over a
 * streaming turn). Returns p50/p95/p99, frames over 16.7 / 33 ms, long-task count and the peak
 * number of simultaneously running animations.
 */
export async function frames(page, action, { ms = 4000 } = {}) {
  await page.evaluate(() => {
    const s = { last: performance.now(), dts: [], long: 0, peak: 0, stop: false }
    window.__frames = s
    try { new PerformanceObserver((l) => { s.long += l.getEntries().length }).observe({ entryTypes: ["longtask"] }) } catch {}
    const tick = (t) => {
      s.dts.push(t - s.last); s.last = t
      s.peak = Math.max(s.peak, document.getAnimations().length)
      if (!s.stop) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await action()
  await page.waitForTimeout(ms)
  return page.evaluate(() => {
    const s = window.__frames; s.stop = true
    const d = s.dts.slice(2).sort((a, b) => a - b)
    const q = (p) => +(d[Math.min(d.length - 1, Math.floor(d.length * p))] ?? 0).toFixed(1)
    return { frames: d.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), over17: d.filter((x) => x > 16.7).length, over33: d.filter((x) => x > 33).length, longTasks: s.long, peakAnimations: s.peak }
  })
}
