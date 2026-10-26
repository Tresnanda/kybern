/**
 * Verify a release `.app.tar.gz`, Windows `-setup.exe` or Linux `.AppImage` against its `.sig` with the key the updater
 * trusts (`bun scripts/verify-archive.ts <archive>`). The updater refuses a signature whose trusted comment does not
 * name the asset (`platform/update.ts`), so a signer that wrote anything else fails here, before the upload.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import conf from '../../desktop/src-tauri/tauri.conf.json'
import { verifyMinisign } from '../src/platform/minisign.ts'
const archive = process.argv[2]
if (!archive) throw Error('usage: verify-archive.ts <archive.app.tar.gz | setup.exe | .AppImage>')
const { trustedComment } = verifyMinisign(readFileSync(archive), readFileSync(`${archive}.sig`, 'utf8'), process.env.KYBERN_UPDATE_PUBKEY ?? conf.plugins.updater.pubkey)
if (archive.endsWith('.exe') && !trustedComment.split('\t').includes(`file:${path.basename(archive)}`)) throw Error(`The signature's trusted comment does not name ${path.basename(archive)}: ${trustedComment}`)
console.log(`signature ok: ${trustedComment}`)
