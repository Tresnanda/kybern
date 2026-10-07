import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function signingIdentity(description) {
  const value = (field) => description.match(new RegExp(`^${field}=(.*)$`, 'm'))?.[1]
  return {
    identifier: value('Identifier'),
    team: value('TeamIdentifier'),
    authority: value('Authority'),
    adHoc: value('Signature') === 'adhoc',
    requirement: description.match(/(?:# )?designated => (.*)/)?.[1] ?? '',
  }
}

export function verifyIdentities(app, sidecar, allowAdHoc = false) {
  if (app.identifier !== 'dev.kybern.desktop') throw new Error('Unexpected desktop signing identifier')
  if (app.adHoc || sidecar.adHoc) {
    if (!allowAdHoc || !app.adHoc || !sidecar.adHoc) {
      throw new Error('Expected certificate signatures on both the desktop app and its bundled sidecar')
    }
    return 'adhoc'
  }
  for (const identity of [app, sidecar]) {
    if (!identity.authority || !identity.team || identity.team === 'not set') {
      throw new Error('The signed app and sidecar must have an Apple certificate identity')
    }
    if (/\bcdhash\b/.test(identity.requirement) || !/\b(?:anchor|certificate)\b/.test(identity.requirement)) {
      throw new Error('The signing requirement must identify the certificate, not one build hash')
    }
  }
  if (app.team !== sidecar.team) throw new Error('The app and sidecar must use the same signing team')
  return 'certificate'
}

export function checkBundle(appPath, allowAdHoc = false) {
  const run = (args) => {
    const result = spawnSync('codesign', args, { encoding: 'utf8' })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`Code-signature verification failed: ${result.stderr.trim()}`)
    return result.stdout + result.stderr
  }
  run(['--verify', '--deep', '--strict', appPath])
  const app = signingIdentity(run(['--display', '--requirements', '-', '--verbose=4', appPath]))
  // The daemon keeps privacy grants across updates; the CLI must match it.
  const modes = ['kybernd', 'kybern'].map((name) =>
    verifyIdentities(app, signingIdentity(run(['--display', '--requirements', '-', '--verbose=4', `${appPath}/Contents/MacOS/${name}`])), allowAdHoc))
  return modes[0]
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (!process.argv[2]) throw new Error('Usage: verify-macos-signing.mjs <app> [--allow-adhoc]')
    const mode = checkBundle(process.argv[2], process.argv.includes('--allow-adhoc'))
    console.log(mode === 'certificate' ? 'Verified certificate identity on the app, daemon and CLI.'
      : 'Verified ad-hoc build. Privacy permissions may need to be granted again after updates.')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
