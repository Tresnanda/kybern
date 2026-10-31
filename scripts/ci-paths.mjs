import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const all = { rust: true, release: true, gpuix: true }
const self = /^(\.github\/(workflows\/ci\.yml|actions\/setup-pnpm-apps\/)|scripts\/ci-paths\.(mjs|test\.mjs)$)/
const paths = {
  rust: /^(crates\/|fixtures\/|Cargo\.(toml|lock)$|rust(-toolchain|fmt)\.toml$|\.cargo\/)/,
  release: /^(scripts\/|\.github\/|dist-workspace\.toml$|Cargo\.toml$|crates\/kybern\/dist\.toml$|crates\/kybern-drivers\/src\/cursor\/sdk\/)/,
  gpuix: /^(apps\/gpuix\/|packages\/|assets\/release-background\.png$|fixtures\/|crates\/kybern-daemon\/src\/visuals\/)/,
}

export function affectedJobs(files) {
  if (files.some(file => self.test(file))) return { ...all }
  return Object.fromEntries(Object.entries(paths).map(([job, pattern]) => [job, files.some(file => pattern.test(file))]))
}

export function workspaceVersion(manifest) {
  const section = manifest.split(/^\[workspace\.package\][ \t]*\r?$/m)[1]?.split(/^\[/m)[0]
  const version = section?.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
  if (!version) throw new Error('Cannot read the workspace version')
  return version
}

const command = (bin, args) => execFileSync(bin, args, {
  encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
})

export function selectJobs(eventName, event, repository, run = command) {
  if (eventName === 'workflow_dispatch') return { ...all }
  try {
    if (eventName === 'pull_request') {
      if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !Number.isSafeInteger(event.number) || event.number < 1) {
        throw new Error('Invalid pull request')
      }
      const files = JSON.parse(run('gh', ['api', '--paginate', '--slurp',
        `repos/${repository}/pulls/${event.number}/files?per_page=100`])).flat()
      // GitHub caps this endpoint at 3,000 files. Never filter a truncated list.
      if (files.length >= 3000) return { ...all }
      return affectedJobs(files.flatMap(file => [file.filename, file.previous_filename].filter(Boolean)))
    }
    if (eventName !== 'push' || event.ref !== 'refs/heads/main') throw new Error('Unexpected CI event')
    const { before, after } = event
    if (![before, after].every(sha => /^[0-9a-f]{40}$/.test(sha) && !/^0+$/.test(sha))) {
      throw new Error('No usable push comparison')
    }
    // Checkout is shallow. Fetch just the old endpoint; diff needs no ancestry.
    try { run('git', ['cat-file', '-e', `${before}^{commit}`]) } catch {
      run('git', ['fetch', '--no-tags', '--depth=1', 'origin', before])
    }
    const oldVersion = workspaceVersion(run('git', ['show', `${before}:Cargo.toml`]))
    const newVersion = workspaceVersion(run('git', ['show', `${after}:Cargo.toml`]))
    if (oldVersion !== newVersion) return { ...all }
    // Include both names of a rename as deletion + addition. NUL separators
    // preserve filenames with whitespace; compare the whole push, not HEAD^.
    return affectedJobs(run('git', ['diff', '--name-only', '--no-renames', '-z', before, after, '--']).split('\0').filter(Boolean))
  } catch {
    console.warn('Could not determine all changed inputs; running the full CI suite.')
    return { ...all }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
  const jobs = selectJobs(process.env.GITHUB_EVENT_NAME, event, process.env.GITHUB_REPOSITORY)
  const output = Object.entries(jobs).map(([job, enabled]) => `${job}=${enabled}`).join('\n') + '\n'
  console.log(output.trimEnd())
  appendFileSync(process.env.GITHUB_OUTPUT, output)
}
