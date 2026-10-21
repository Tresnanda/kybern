// Send a prompt in an existing thread and record what animates from the click to the settled turn:
// the double-exposure fix (2.41), the send/stop swap (2.5), the working → worked chrome (2.1).
import { open, thread, probe, OUT } from "./probe-lib.mjs"
const scheme = process.env.SCHEME || "dark"
const reduced = process.env.REDUCED === "1"
const tag = `send-${scheme}${reduced ? "-reduced" : ""}`
const { browser, page } = await open({ scheme, reduced })
await thread(page, "Fix the retry loop")
const editor = page.locator('[data-testid="composer-editor"]')
await editor.click()
await page.keyboard.type("SCENE_WORK once more")
await page.screenshot({ path: `${OUT}/${tag}-typed.png` })
// Slow the RPC so the editor/bubble overlap would show if the text were still in the editor.
await page.route("**/*", (r) => r.continue())
await probe(page, `${tag}-send`, async () => { await page.keyboard.press("Enter") }, { window: 400, mid: true })
const editorText = await editor.innerText()
console.log("editor after send:", JSON.stringify(editorText))
await page.waitForTimeout(3500)
await page.screenshot({ path: `${OUT}/${tag}-working.png` })
// Wait for the turn to settle (the scene takes ~14 s) and watch the settle commit.
await probe(page, `${tag}-settle`, async () => {
  await page.waitForFunction(() => /Worked for/.test(document.body.innerText) && document.querySelectorAll('[data-timeline-row-kind="live-work"]').length === 0, null, { timeout: 40000 })
}, { window: 700, mid: true })
await browser.close()
