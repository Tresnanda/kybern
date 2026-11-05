// The guard behind #232: no raw error text reaches the screen. A caught error's own words (`String(e)`, `errorText(e)`, `e.message`) are
// technical (class names, exit codes, paths); they belong behind "Show details". Say the failure with `describeProblem` instead:
// `toastProblem(e, { action })`, `<ProblemLine error={asError(e)} action />`, `<ProblemState {...problemProps(...)} />`, or `problemSentence`
// for a status string, and keep the error itself in state, not its text.
//
// The scan reads every shipped source file under `src/` (tests, verification scripts and fixtures excluded) and fails on a line that turns a
// caught error into text. Logging is fine (`console.*`), and so is `errorMessage(e)` for matching against a known message.
import { describe, expect, test } from 'bun:test'
import { Glob } from 'bun'
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * Files and folders (relative to `src/`, with `/`) that still show raw errors. Each belongs to a lane of #232 that has not merged yet; when
 * its rewrite lands the entry goes. Nothing is added here for new code: use the Problem API.
 */
export const RAW_ERROR_ALLOWLIST: string[] = [
  // Family 1: agents and first run
  'Composer.tsx',
  'composer/',
  'onboarding/',
  'dialogs/Account',
  'dialogs/useAccountLogin.ts',
  'settings/InstalledAgents.tsx',
  'settings/Cursor.tsx',
  // Family 2: git and PRs
  'environment/Panel.tsx',
  'dock/Review.tsx',
  'dock/Diff.tsx',
  'pulls/',
  'dialogs/Repositories.tsx',
  'dialogs/GroupProject.tsx',
  // Family 3: machines
  'settings/Accounts.tsx',
  'settings/LoginBroker.tsx',
  'settings/Machines.tsx',
  'machines/network.ts',
  'state.ts', // statusDetail, shown by shell/Connection.tsx
]

const SRC = join(import.meta.dir, '..')
/** A variable a `catch` or `.catch(` hands out. */
const CAUGHT = '(?:e|err|error|cause|reason|ex|problem)'
const RAW = [
  { name: 'errorText(', test: /(?<![\w.])errorText\(/, skip: /function errorText|import .*errorText/ },
  { name: 'String(error)', test: new RegExp(String.raw`\bString\(\s*${CAUGHT}\s*\)`) },
  { name: 'error.message', test: new RegExp(String.raw`(?<![\w.])${CAUGHT}\.message\b`) },
  { name: '${e}', test: /\$\{\s*(?:e|err)\s*\}/ },
  { name: 'String(error.message)', test: new RegExp(String.raw`String\(\s*\(?\s*${CAUGHT}(?: as [^)]*)?\)?\.message`) },
]
/** Not shipped UI: tests, on-screen checks, fixtures and screenshot scripts. */
const NOT_SHIPPED = /(\.test\.|verify|\.shots\.|\.fixture\.|\.live\.|\.drive\.|\.perf\.|\.app\.ts$|-check\.ts$|-lab\.tsx?$|\.bench\.)/
/** Logging is where raw text belongs. */
const LOGGING = /\bconsole\.\w+\(|\blog(?:Error|Warn)?\(|\bstartupMark\(|\bmemoryStep\(/

export interface RawErrorHit { file: string; line: number; found: string; text: string }

/** Every line in `source` that turns a caught error into text, outside logging. */
export function rawErrorsIn(file: string, source: string): RawErrorHit[] {
  const hits: RawErrorHit[] = []
  source.split('\n').forEach((text, index) => {
    const code = text.replace(/\/\/.*$/, '')
    if (LOGGING.test(code)) return
    for (const raw of RAW) {
      if (raw.skip?.test(code)) continue
      if (raw.test.test(code)) hits.push({ file, line: index + 1, found: raw.name, text: text.trim().slice(0, 140) })
    }
  })
  return hits
}

const allowed = (file: string) => RAW_ERROR_ALLOWLIST.some((entry) => (entry.endsWith('/') ? file.startsWith(entry) : file === entry || file.startsWith(entry)))

let scanned: RawErrorHit[] | undefined
/** Every hit in the shipped sources, scanned once. */
function scan(): RawErrorHit[] {
  if (scanned) return scanned
  const hits: RawErrorHit[] = []
  for (const path of new Glob('**/*.{ts,tsx}').scanSync({ cwd: SRC })) {
    const file = path.split(sep).join('/')
    if (NOT_SHIPPED.test(file) || file.includes('node_modules')) continue
    hits.push(...rawErrorsIn(file, readFileSync(join(SRC, path), 'utf8')))
  }
  scanned = hits
  return hits
}

describe('raw errors', () => {
  test('the scan sees each way of turning a caught error into text', () => {
    const sample = [
      "toast.error('Nope', { description: String(e) })",
      'setError(errorText(err))',
      'setStatus(error.message)',
      'setStatus(String((e as Error).message))',
      'setStatus(`Failed: ${err}`)',
      "console.warn('x', String(e))",
      'const text = errorMessage(e)',
      'function errorText(error: unknown) {',
      'return event.message',
    ].join('\n')
    expect(rawErrorsIn('x.ts', sample).map((hit) => hit.line)).toEqual([1, 2, 3, 4, 5])
  })

  test('no source file shows a raw error outside the allowlist', () => {
    const offenders = scan().filter((hit) => !allowed(hit.file))
    const report = offenders.map((hit) => `${hit.file}:${hit.line} ${hit.found}  ${hit.text}`).join('\n')
    expect(report).toBe('')
  }, 60_000)

  test('the allowlist lists only files that still show a raw error', () => {
    const seen = new Set(scan().map((hit) => hit.file))
    const stale = RAW_ERROR_ALLOWLIST.filter((entry) => ![...seen].some((file) => (entry.endsWith('/') ? file.startsWith(entry) : file === entry || file.startsWith(entry))))
    expect(stale).toEqual([])
  }, 60_000)
})
