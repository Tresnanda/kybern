import { launch } from '@gpuix/react/automation'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'

const out = process.env.KYBERN_PARITY_OUT ?? 'screenshots/transcript-parity'
mkdirSync(out, { recursive: true })
const appDir = resolve(import.meta.dir, '../..')

/** Poll observed state, rather than assuming another process paints in N ms. */
async function until(label: string, condition: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out: ${label}`)
}

for (const mode of process.argv[2] ? [process.argv[2]] : ['keys', 'long', 'prompt']) {
  const app = await launch({ command: 'bun', args: [appDir + '/src/transcript/parity.fixture.tsx'], env: { ...process.env, GPUIX_BACKGROUND: '1', KYBERN_PARITY_MODE: mode } })
  try {
    await app.getByTestId('fixture-ready').waitFor({ timeoutMs: 60_000 })
    const editor = app.getByTestId('composer')
    await until('composer painted', async () => (await editor.bounds()).width > 0)
    const events = async () => JSON.parse(await app.getByTestId('send-events').textContent())
    const sent = async (count: number) => {
      await until(`${count} sends`, async () => (await events()).length === count)
      await app.getByTestId('composer-placeholder').waitFor()
    }
    const menuClosed = () => until('menu closed', async () => await app.getByTestId('completion').count() === 0)
    const painted = async () => (await app.call('getPaintedText', {})).text
    const codeLines = async () => (await painted()).filter(text => text.includes('value'))

    if (mode === 'keys') {
      await editor.fill('first')
      await editor.press('shift-enter')
      await editor.press('x')
      await editor.press('enter')
      await sent(1)
      assert.deepEqual((await events())[0], { delivery: 'send', message: { parts: [{ type: 'text', text: 'first\nx' }] } })
      await app.getByTestId('fixture-running').click()
      await editor.fill('queue')
      await editor.press('enter')
      await sent(2)
      assert.equal((await events())[1].delivery, 'queue')
      await editor.fill('steer')
      await editor.press('cmd-enter')
      await sent(3)
      assert.equal((await events())[2].delivery, 'steer')
      await app.getByTestId('fixture-running').click()
      await editor.fill('@')
      await app.getByTestId('completion-1').waitFor()
      const id = (await editor.element()).id
      // press() only emits keyDown; exercise a complete physical key press.
      await app.call('keyDown', { elementId: id, key: 'down' })
      await app.call('keyUp', { elementId: id, key: 'down' })
      await until('second item selected', async () => (await app.getByTestId('completion-selected').textContent()).includes('Second message'))
      await editor.press('enter')
      await menuClosed()
      assert.equal((await events()).length, 3)
      await editor.press('enter')
      await sent(4)
      assert.equal((await events())[3].message.parts.find((part: { type: string }) => part.type === 'thread_reference').thread_id, 'fixture-second')
      await editor.fill('@')
      await app.getByTestId('completion').waitFor()
      await editor.press('tab')
      await menuClosed()
      await editor.press('enter')
      await sent(5)
      await editor.fill('@')
      await app.getByTestId('completion').waitFor()
      await editor.press('escape')
      await menuClosed()
      await editor.fill('')
      await app.getByTestId('fixture-approval').click()
      await editor.click()
      await editor.press('1')
      await until('approval digit removed', async () => await app.getByTestId('composer-placeholder').count() === 1)
      await editor.press('enter')
      assert.equal((await events()).length, 5, 'approval digit must not become a draft/send')
      console.log('KEYS PASSED: multiline, send, queue, steer exactly once, arrow selection, Enter/Tab, Escape, digit consumption')
    } else if (mode === 'narrow') {
      await until('wrapped code painted', async () => (await painted()).some(text => text.includes('fourthArgument')))
      await app.screenshot({ path: out + '/narrow.png' })
      console.log('NARROW PASSED: long line is reachable')
    } else if (mode === 'prompt') {
      await app.getByTestId('transcript-surface').wheel(0, 10_000)
      await app.getByTestId('subagent-prompt-toggle').waitFor()
      assert.equal(await app.getByTestId('subagent-prompt-toggle').textContent(), 'Show full prompt')
      await app.screenshot({ path: out + '/prompt-clamped.png' })
      await app.getByTestId('subagent-prompt-toggle').click()
      await until('full prompt expanded', async () => await app.getByTestId('subagent-prompt-toggle').textContent() === 'Show less')
      console.log('SUBAGENT PROMPT PASSED')
    } else {
      const ps = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
      const pid = ps.split('\n').find(line => line.includes('bun ' + appDir + '/src/transcript/parity.fixture.tsx'))!.trim().split(/\s+/)[0]!
      const footprint = () => execFileSync('footprint', ['-p', pid], { encoding: 'utf8' }).match(/Footprint:\s+([^\n]+)/)?.[1]
      await app.getByTestId('transcript-surface').wheel(0, 10_000)
      await until('collapsed code painted', async () => (await codeLines()).length > 0)
      console.log('LONG BEFORE', footprint())
      await app.getByTestId('code-expand').click()
      await until('expanded code', async () => await app.getByTestId('code-expand').textContent() === 'Show less')
      console.log('LONG EXPANDED', footprint())
      const top = (await codeLines())[0]
      await app.getByTestId('transcript-surface').wheel(0, -20_000)
      await until('scrolled code painted', async () => (await codeLines()).length > 0 && (await codeLines())[0] !== top)
      await app.screenshot({ path: out + '/long-expanded.png' })
      console.log('LONG SCROLLED', footprint())
      const before = (await codeLines())[0]
      console.log('ANCHOR BEFORE', before?.split('\n')[0])
      await app.getByTestId('fixture-short').click()
      await until('short thread painted', async () => (await painted()).some(text => text.includes('A short answer.')))
      console.log('LONG SWITCHED', footprint())
      await app.getByTestId('fixture-long').click()
      await until('reading anchor restored', async () => (await codeLines())[0] === before)
      console.log('ANCHOR AFTER', (await codeLines())[0]?.split('\n')[0])
      await app.screenshot({ path: out + '/anchor-restored.png' })
      await app.getByTestId('response-image').click()
      await app.getByTestId('image-lightbox').waitFor()
      await app.screenshot({ path: out + '/lightbox.png' })
      await app.getByTestId('image-lightbox').press('escape')
      await until('lightbox exit completed', async () => await app.getByTestId('image-lightbox').count() === 0)
      console.log('LONG/ANCHOR/LIGHTBOX PASSED')
    }
  } catch (error) {
    console.error('VERIFY FAILED', mode, error)
    await app.screenshot({ path: out + '/' + mode + '-failed.png' })
    process.exitCode = 1
  } finally {
    await app.close()
  }
}
process.exit(process.exitCode ?? 0)
