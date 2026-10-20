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
  const row = page.getByText(title, { exact: false }).first()
  // Older threads sit under "Show N more".
  if (!(await row.isVisible().catch(() => false))) await page.getByText(/^Show \d+ more$/).first().click({ timeout: 2000 }).catch(() => {})
  await row.click()
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
 * streaming turn). Returns p50/p95/p99, frames over 20 / 33 ms (a 60 Hz frame is 16.7 ms, so 16.7 itself is just jitter), long-task count and the peak
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
    return { frames: d.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), over20: d.filter((x) => x > 20).length, over33: d.filter((x) => x > 33).length, longTasks: s.long, peakAnimations: s.peak }
  })
}

/**
 * Frame strip: arm a frame loop that pauses every finite animation and transition the moment it
 * starts, run `action`, then step each to a fraction of its own duration and screenshot
 * (`<label>-f20.png`, ...). Headless screenshots are too slow to catch a 250 ms motion, so this is
 * the reliable way to see the middle of one.
 */
export async function scrub(page, label, action, fractions = [0.2, 0.5, 0.8], { wait = 450 } = {}) {
  await page.evaluate(() => {
    window.__scrubbed = new Set()
    window.__scrubStop = false
    const loop = () => {
      for (const a of document.getAnimations()) {
        if (window.__scrubbed.has(a) || a.playState !== "running") continue
        const t = a.effect?.getComputedTiming()
        if (!t || !Number.isFinite(t.endTime) || t.iterations === Infinity) continue
        window.__scrubbed.add(a); a.pause()
      }
      if (!window.__scrubStop) requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  })
  await action()
  await page.waitForTimeout(wait)
  await page.evaluate(() => { window.__scrubStop = true })
  for (const f of fractions) {
    await page.evaluate((f) => window.__scrubbed.forEach((a) => {
      const t = a.effect.getComputedTiming()
      a.currentTime = (t.delay || 0) + f * (t.duration || 0)
    }), f)
    await page.waitForTimeout(60)
    await page.screenshot({ path: `${OUT}/${label}-f${Math.round(f * 100)}.png` })
  }
  await page.evaluate(() => window.__scrubbed.forEach((a) => a.play()))
  await page.waitForTimeout(800)
}
