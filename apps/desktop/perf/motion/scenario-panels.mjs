// Composer-stack request cards, model picker and scroll-to-bottom: what animates and with which values.
import { open, thread, probe, OUT } from "./probe-lib.mjs"
const scheme = process.env.SCHEME || "dark"
const reduced = process.env.REDUCED === "1"
const tag = `panels-${scheme}${reduced ? "-reduced" : ""}`
const { browser, page } = await open({ scheme, reduced })

// Approval enter (2.3) and exit on resolve (2.4); the RPC must not wait for the exit.
await probe(page, `${tag}-approval-open`, () => thread(page, "SCENE_APPRO"), { window: 700, mid: true })
let rpcAt = 0
page.on("request", () => {})
await probe(page, `${tag}-approval-resolve`, async () => {
  rpcAt = Date.now()
  await page.getByText("Approve once").first().click()
}, { window: 500, mid: true })

// Question: enter, step change (2.25), send.
await probe(page, `${tag}-question-open`, () => thread(page, "SCENE_QUESTI"), { window: 700, mid: true })
await page.getByText("SQLite").first().click()
await probe(page, `${tag}-question-step`, async () => { await page.getByRole("button", { name: /Next|Review answers/ }).first().click() }, { window: 600, mid: true })
await probe(page, `${tag}-question-send`, async () => { await page.getByRole("button", { name: /Send answer/ }).first().click() }, { window: 500, mid: true })

// Model picker open / close (2.11) / tabs (2.12) / star (2.13).
await thread(page, "Explain the retry design")
const trigger = page.getByText("claude-fixture").first()
await probe(page, `${tag}-picker-open`, () => trigger.click(), { window: 500, mid: true })
await probe(page, `${tag}-picker-close`, () => page.keyboard.press("Escape"), { window: 400, mid: true })

// Scroll-to-bottom (2.15): scroll up a long thread, then back.
await thread(page, "Fix the retry loop")
const scroller = page.locator("[data-chat-transcript-pane] [class*=overflow-y]").first()
await probe(page, `${tag}-scrolltop`, async () => { await page.mouse.move(900, 400); await page.mouse.wheel(0, -1200) }, { window: 600, mid: true })
await probe(page, `${tag}-scrollbottom`, async () => { await page.getByLabel("Scroll to bottom").click() }, { window: 600, mid: true })
await browser.close()
