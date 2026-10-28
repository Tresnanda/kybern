// Ed25519 check of a machine's identity document (design §3.2), for routes of
// machines that are members of the network. A saved daemon older than the
// network (`member: false`) never reaches it.
import { createPublicKey, verify } from 'node:crypto'
import type { ProofInput } from '../../../../packages/kybern-client/src/machineRoutes.ts'

// SubjectPublicKeyInfo prefix of a raw 32-byte Ed25519 key.
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex')

export function verifyMachineProof(input: ProofInput): boolean {
  try {
    const raw = Buffer.from(input.signingKey, 'base64')
    if (raw.length !== 32) return false
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: 'der', type: 'spki' })
    return verify(null, input.message, key, Buffer.from(input.proof, 'base64'))
  } catch {
    return false
  }
}
