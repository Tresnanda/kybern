// Minisign verification, as Tauri's updater does it (the `minisign-verify`
// crate): the feed's `signature` and the configured `pubkey` are base64 of the
// minisign text files. Legacy `Ed` signatures sign the file itself; `ED`
// (what `tauri signer sign` writes) signs its BLAKE2b-512 digest. The trusted
// comment is covered by a second, global signature.
import { createHash, createPublicKey, verify } from 'node:crypto'

const decode = (base64: string) => Buffer.from(base64.trim(), 'base64')
const lines = (file: string) => decode(file).toString('utf8').split('\n').map(line => line.replace(/\r$/, ''))

export interface PublicKey { keyId: Buffer; key: ReturnType<typeof createPublicKey> }

/** The base64 public key from `tauri.conf.json` (`plugins.updater.pubkey`). */
export function parsePublicKey(pubkey: string): PublicKey {
  const raw = decode(lines(pubkey).find(line => line && !line.startsWith('untrusted comment:')) ?? '')
  if (raw.length !== 42 || raw.toString('latin1', 0, 2) !== 'Ed') throw Error('The update public key is invalid')
  // Ed25519 SubjectPublicKeyInfo: a fixed 12-byte prefix, then the 32 raw bytes.
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw.subarray(10)])
  return { keyId: raw.subarray(2, 10), key: createPublicKey({ key: spki, format: 'der', type: 'spki' }) }
}

/** Throws unless `signature` (base64 minisign file) is a valid signature of `data` by `pubkey`. */
export function verifyMinisign(data: Uint8Array, signature: string, pubkey: string): { trustedComment: string } {
  const key = parsePublicKey(pubkey)
  const [untrusted, sigLine, trustedLine, globalLine] = lines(signature)
  if (!untrusted?.startsWith('untrusted comment:') || !sigLine || !trustedLine?.startsWith('trusted comment: ') || !globalLine) throw Error('The update signature is malformed')
  const sig = decode(sigLine)
  if (sig.length !== 74) throw Error('The update signature is malformed')
  const algorithm = sig.toString('latin1', 0, 2)
  if (algorithm !== 'Ed' && algorithm !== 'ED') throw Error('The update signature uses an unsupported algorithm')
  if (!sig.subarray(2, 10).equals(key.keyId)) throw Error('The update was signed with a different key')
  const signed = algorithm === 'ED' ? createHash('blake2b512').update(data).digest() : Buffer.from(data)
  if (!verify(null, signed, key.key, sig.subarray(10))) throw Error('The update signature does not match the download')
  const trustedComment = trustedLine.slice('trusted comment: '.length)
  const global = decode(globalLine)
  if (!verify(null, Buffer.concat([sig.subarray(10), Buffer.from(trustedComment, 'utf8')]), key.key, global)) throw Error('The update signature’s trusted comment was altered')
  return { trustedComment }
}
