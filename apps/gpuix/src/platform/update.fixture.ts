// The app with an update ready: a local signed feed served in this process, a
// throwaway key and a scratch bundle (never the installed app), then the
// normal entry point. Used by the visual pair's update screens.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { archive, fakeBundle, serveFeed, testKey } from './verify.feed.ts'
import { assertScratchDataDir } from './verify.lib.ts'

assertScratchDataDir()

const root = mkdtempSync(path.join(tmpdir(), 'kybern-update-fixture-'))
const key = testKey()
const next = archive(fakeBundle(path.join(root, 'next'), '0.9.2'), path.join(root, 'next.tar.gz'))
const feed = await serveFeed({ version: '0.9.2', archive: next, signature: key.signFile(next, 'gpuix.app.tar.gz') })
Object.assign(process.env, {
  KYBERN_UPDATE_FEED: feed.url, KYBERN_UPDATE_PUBKEY: key.pubkey, KYBERN_UPDATE_BUNDLE: fakeBundle(path.join(root, 'installed'), '0.9.1'),
  KYBERN_UPDATE_FIRST_CHECK_MS: '200', KYBERN_UPDATE_NO_RELAUNCH: '1', KYBERN_GPUIX_VERSION: '0.9.1',
})
await import('../main.tsx')
