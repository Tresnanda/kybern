// Queue rows, visual reply zoom, image lightbox, delegation and subagent rows.
import { open, thread, probe, OUT } from "./probe-lib.mjs"
const scheme = process.env.SCHEME || "dark"
const reduced = process.env.REDUCED === "1"
const tag = `rest-${scheme}${reduced ? "-reduced" : ""}`
const { browser, page } = await open({ scheme, reduced })

// Queue (2.7 chip group already running; 2.27 row leave).
await thread(page, process.env.LIVE_TITLE || "SCENE_LIVE")
const editor = page.locator('[data-testid="composer-editor"]')
await editor.click()
await page.keyboard.type("queued follow up")
await probe(page, `${tag}-queue-add`, () => page.keyboard.press("Enter"), { window: 500, mid: true })
await probe(page, `${tag}-queue-remove`, async () => { await page.getByLabel("Delete queued follow-up").first().click() }, { window: 500, mid: true })

// Visual reply expand/collapse (2.24): pointer.
await thread(page, "Explain the retry")
await page.waitForTimeout(1500)
const expand = page.getByLabel("Expand preview").first()
await expand.scrollIntoViewIfNeeded()
const box = await expand.boundingBox()
await page.mouse.move(box.x - 40, box.y + 40) // over the card, so the control reveals itself
await page.waitForTimeout(400)
await probe(page, `${tag}-visual-expand`, async () => { await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2) }, { window: 600, mid: true })
await probe(page, `${tag}-visual-collapse`, async () => { await page.getByLabel("Close expanded preview").click() }, { window: 600, mid: true })

// Lightbox (2.23): attach a small image, send it, open its thumbnail.
// fixture image is committed next to this script
await thread(page, "Fix the retry loop")
await page.locator('input[type="file"]').first().setInputFiles(new URL("./lightbox-fixture.png", import.meta.url).pathname)
await page.waitForTimeout(800)
await editor.click()
await page.keyboard.type("image please")
await page.keyboard.press("Enter")
await page.waitForTimeout(2500)
const thumb = page.getByLabel(/Preview Attached image/).last()
await probe(page, `${tag}-lightbox-open`, () => thumb.click(), { window: 700, mid: true })
await page.waitForTimeout(500)
await probe(page, `${tag}-lightbox-close`, () => page.getByLabel("Close").first().click(), { window: 500, mid: true })

// Delegation and subagent rows.
await probe(page, `${tag}-delegation`, () => thread(page, "Split scene delegate"), { window: 600, mid: false })
await probe(page, `${tag}-subagent`, () => thread(page, "Audit slow queries"), { window: 600, mid: false })
await browser.close()
