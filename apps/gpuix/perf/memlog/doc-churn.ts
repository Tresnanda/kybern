/**
 * Native Markdown documents for streaming replies (`createMarkdownDocument` /
 * `updateMarkdownDocument` / `releaseMarkdownDocument`), driven without
 * painting: rounds of replies, each grown in `step`-character updates and
 * released. Prints footprint and `App-Specific Tag 1` after each round.
 *
 *   KYBERN_DATA_DIR=<scratch> bun perf/memlog/doc-churn.ts <markdown file> [rounds] [replies per round] [step]
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../../src/requests/harness.ts'

const [file, rounds = '5', replies = '10', step = '24'] = process.argv.slice(2)
assert(file, 'Name a Markdown file')
const data = process.env.KYBERN_DATA_DIR!
assert(data?.includes('scratch'), 'Explicit scratch data directory required')
const client = path.join(data, 'client-doc-churn')
mkdirSync(client, { recursive: true })
const f = await launchFixture(path.join(import.meta.dir, 'app.ts'), {
  KYBERN_DATA_DIR: data, KYBERN_URL: '', KYBERN_TOKEN: '', KYBERN_GPUIX_RESOURCES: '', KYBERND: '', KYBERN_BUNDLED_CLI: '',
  KYBERN_CLIENT_CONFIG_DIR: client, KYBERN_GPUIX_CREDENTIALS_DIR: path.join(client, 'credentials'), GPUIX_BACKGROUND: '1', KYBERN_MEMORY_LOG: '0',
})
try {
  await f.app.getByTestId('app-ready').waitFor()
  const port = JSON.parse(readFileSync(path.join(client, 'memlog-control.json'), 'utf8')).port
  const sample = (name: string) => {
    const text = execFileSync('footprint', ['-p', String(f.pid)], { encoding: 'utf8' })
    const tag = /^\s*([\d.]+) (KB|MB|GB)\s+.*App-Specific Tag 1$/m.exec(text)
    console.log(name, /Footprint: ([\d.]+ \w+)/.exec(text)?.[1], 'tag1', tag ? `${tag[1]} ${tag[2]}` : null)
  }
  await Bun.sleep(3000)
  sample('start')
  for (let round = 1; round <= Number(rounds); round++) {
    const res = await (await fetch(`http://127.0.0.1:${port}`, { method: 'POST', body: JSON.stringify({ action: 'doc-churn', file: path.resolve(file), replies: Number(replies), step: Number(step) }) })).json()
    await Bun.sleep(2000)
    sample(`round-${round} (${res.updates} updates)`)
  }
} finally {
  await f.close()
}
