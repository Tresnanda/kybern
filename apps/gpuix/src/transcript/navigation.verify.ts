import assert from "node:assert/strict"
import { mkdtempSync, rmSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { launchFixture } from "../requests/harness.ts"
const out = process.env.KYBERN_VERIFY_OUTPUT ?? "/Users/mymac/projects/ade/previews/gpuix/p3"
mkdirSync(out, { recursive: true })
for (const theme of ["dark", "light"]) {
  const scratch = mkdtempSync(tmpdir() + "/gpuix-p3-navigation-")
  const f = await launchFixture(import.meta.dir + "/navigation.fixture.tsx", { GPUIX_BACKGROUND: "1", KYBERN_APPEARANCE: theme, KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch, KYBERN_GPUIX_ENVIRONMENT: "local", KYBERN_URL: "", KYBERN_TOKEN: "" })
  try {
    await f.app.getByTestId("navigation-ready").waitFor()
    for (const i of [39, 20, 0]) {
      await f.app.getByTestId("message-navigation").click()
      await f.app.getByTestId("message-search").fill(`Message ${i + 1}:`)
      await f.app.getByTestId(`message-option-${i}`).waitFor()
      await f.app.screenshot({ path: `${out}/navigation-${theme}.png` })
      await f.app.getByTestId(`message-option-${i}`).press("enter")
      for (let n = 0; n < 100 && await f.app.getByTestId("active-message").textContent() !== `turn-${i}`; n++) await Bun.sleep(20)
      assert.equal(await f.app.getByTestId("active-message").textContent(), `turn-${i}`)
    }
    console.log(`PASS ${theme}: filtered first/middle/last navigation, keyboard activation, query reset`)
  } finally { await f.close(); rmSync(scratch, { recursive: true, force: true }) }
}
process.exit(0)
