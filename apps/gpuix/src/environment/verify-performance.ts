import { launch } from '@gpuix/react/automation'
import { execFileSync, spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const app = await launch({ command: 'bun', args: ['src/main.tsx'], env: { ...process.env, GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: 'dark', KYBERN_DATA_DIR: '/Users/mymac/projects/ade-gpuix-scratch/data', KYBERN_CLIENT_CONFIG_DIR: '/Users/mymac/projects/ade-gpuix-scratch/environment-client', KYBERN_GPUIX_CREDENTIALS_DIR: '/Users/mymac/projects/ade-gpuix-scratch/environment-credentials', KYBERN_GPUIX_THREAD: '01a13e34-40eb-7682-81b0-7cb58da9cc63' } })
const pid = execFileSync('pgrep', ['-P', String(process.pid)], { encoding: 'utf8' }).trim().split('\n')[0]!
const sample = () => new Promise<string>((resolve, reject) => { const child = spawn('bun', ['perf/sample.ts', '15', `GPUIX=${pid}`]); let output = ''; child.stdout.on('data', (value) => output += value); child.on('exit', (code) => code ? reject(Error(`Perf sample failed ${code}`)) : resolve(output)) })
async function toggle() { const target = app.getByTestId('environment-toggle'); await target.waitFor({ timeoutMs: 60000 }); await app.clock.pause(); await app.clock.fastForward(350); await app.clock.resume(); await target.click() }
try {
  await toggle(); await app.getByTestId('environment-note').waitFor(); await app.getByTestId('environment-branch').waitFor()
  const idle = await sample()
  let done = false
  const sampling = sample().finally(() => { done = true })
  let interactions = 0
  while (!done) { await toggle(); await toggle(); interactions += 2 }
  const active = await sampling
  const result = `Idle panel (no screenshots):${idle}\nActive panel (${interactions} toggles, no screenshots):${active}`
  console.log(result)
  writeFileSync('/Users/mymac/projects/ade/previews/gpuix/environments/perf-no-screenshots.txt', result)
} finally { await app.close() }
