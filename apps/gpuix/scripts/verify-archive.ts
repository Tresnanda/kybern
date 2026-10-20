/** Verify a release `.app.tar.gz` against its `.sig` with the key the updater trusts (`bun scripts/verify-archive.ts <archive>`). */
import { readFileSync } from 'node:fs'
import conf from '../../desktop/src-tauri/tauri.conf.json'
import { verifyMinisign } from '../src/platform/minisign.ts'
const archive = process.argv[2]
if (!archive) throw Error('usage: verify-archive.ts <archive.app.tar.gz>')
const { trustedComment } = verifyMinisign(readFileSync(archive), readFileSync(`${archive}.sig`, 'utf8'), process.env.KYBERN_UPDATE_PUBKEY ?? conf.plugins.updater.pubkey)
console.log(`signature ok: ${trustedComment}`)
