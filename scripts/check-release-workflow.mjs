import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// release.yml is `dist generate` output plus one hand edit: custom-desktop does
// not wait for the release gate (see the comment in the file).
// dist-workspace.toml's `allow-dirty = ["ci"]` permits that edit, but it also
// stops dist from reporting a release.yml that no longer matches its config.
// This regenerates the file in a scratch copy of the repository and fails on
// any difference outside custom-desktop's comment and needs list. Needs `dist`
// on PATH, at the cargo-dist-version of dist-workspace.toml.
const root = fileURLToPath(new URL('..', import.meta.url))
const workflow = '.github/workflows/release.yml'
const handEdit = /\n  custom-desktop:\n(?:    #.*\n)*    needs:\n(?:      - .*\n)+/

const scratch = mkdtempSync(path.join(tmpdir(), 'kybern-release-workflow-'))
try {
  for (const file of execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0')) {
    if (file && existsSync(path.join(root, file))) cpSync(path.join(root, file), path.join(scratch, file))
  }
  const config = path.join(scratch, 'dist-workspace.toml')
  writeFileSync(config, readFileSync(config, 'utf8').replace(/^allow-dirty = .*\n/m, ''))
  execFileSync('dist', ['generate', '--mode=ci'], { cwd: scratch, stdio: ['ignore', 'ignore', 'inherit'] })

  const committed = readFileSync(path.join(root, workflow), 'utf8')
  const edit = committed.match(handEdit)
  if (!edit) throw new Error(`${workflow} has no custom-desktop job with a needs list.`)
  const generated = readFileSync(path.join(scratch, workflow), 'utf8')
  if (!handEdit.test(generated)) throw new Error('dist no longer generates custom-desktop in the expected shape; redo the hand edit by hand.')
  const expected = path.join(scratch, 'expected-release.yml')
  writeFileSync(expected, generated.replace(handEdit, edit[0]))
  const diff = spawnSync('diff', ['-u', expected, path.join(root, workflow)], { encoding: 'utf8' })
  if (diff.status !== 0) {
    console.error(diff.stdout || diff.stderr)
    throw new Error(`${workflow} differs from \`dist generate\`. Remove allow-dirty from dist-workspace.toml, run \`dist generate\`, restore allow-dirty and the custom-desktop edit.`)
  }
  console.log(`${workflow} matches dist's output apart from the custom-desktop edit.`)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
