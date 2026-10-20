import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { bootstrapPlan, checkRelease, cliStatus, compareVersions, installCli, parseSshTarget, shellQuote, sshConfigHosts, uninstallCli } from './platform.ts'

test('SSH plans preserve desktop target validation and loopback-only forwarding', () => {
  expect(parseSshTarget('ssh://deploy@10.0.0.4:2222')).toEqual({ target: 'deploy@10.0.0.4', port: 2222 })
  for (const input of ['-oProxyCommand=evil', 'user@-host', 'host name', 'host:0', 'host:65536', 'a@b@c']) expect(() => parseSshTarget(input)).toThrow()
  expect(sshConfigHosts('Host work *.example !other\nHost work staging # comment\n')).toEqual(['work', 'staging'])
  const config = { target: 'deploy@host', port: 2222, localPort: 50001, remotePort: 4173, dataDir: "/tmp/a'$(touch nope)" }
  const plan = bootstrapPlan(config)
  expect(plan.probe.args).toContain('BatchMode=yes')
  expect(plan.probe.stdin).toContain(`KYBERN_DATA_DIR=${shellQuote(config.dataDir)}`)
  expect(plan.tunnel.args).toContain('127.0.0.1:50001:127.0.0.1:4173')
  expect(plan.tunnel.args).toContain('ExitOnForwardFailure=yes')
  expect(plan.startIfUnreachable.stdin).toContain('--bind 127.0.0.1 --port 4173')
  expect(plan.startIfUnreachable.stdin).toContain('systemctl --user enable --now kybernd')
  expect(() => bootstrapPlan(config, 'http://insecure.test/install')).toThrow()
})

test('CLI install/uninstall is idempotent and preserves unrelated executables and links', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gpuix-scratch-cli-'))
  const bundled = path.join(root, 'bundle', 'kybern'), target = path.join(root, 'bin', 'kybern')
  try {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(path.dirname(bundled)); await writeFile(bundled, 'fixture binary')
    expect((await installCli({ bundled, target })).installed).toBe(true)
    expect((await installCli({ bundled, target })).installed).toBe(true)
    await uninstallCli({ bundled, target }); await uninstallCli({ bundled, target })
    await writeFile(target, 'unrelated command')
    await expect(installCli({ bundled, target })).rejects.toThrow('different command')
    await expect(uninstallCli({ bundled, target })).rejects.toThrow('not a link')
    expect(await readFile(target, 'utf8')).toBe('unrelated command')
    await rm(target); await symlink(path.join(root, 'missing'), target)
    expect((await cliStatus({ bundled, target })).occupied).toBe(true)
    await expect(installCli({ bundled, target })).rejects.toThrow()
    await expect(uninstallCli({ bundled, target })).rejects.toThrow('another installation')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('release checks are read-only and reject incomplete or failed manifests', async () => {
  const fetcher = (async () => new Response(JSON.stringify({ version: '0.5.0', notes: 'Release notes' })))
  expect(await checkRelease('0.4.9', fetcher)).toEqual({ version: '0.5.0', notes: 'Release notes', newer: true, installable: false })
  expect(compareVersions('v1.10.0', '1.9.9')).toBeGreaterThan(0)
  expect(compareVersions('1.0.0-preview', '1.0.0')).toBe(0)
  await expect(checkRelease('0.4.9', (async () => new Response('{}')))).rejects.toThrow('incomplete')
  await expect(checkRelease('0.4.9', (async () => new Response('', { status: 503 })))).rejects.toThrow('503')
})
