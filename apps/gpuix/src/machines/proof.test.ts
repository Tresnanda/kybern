import { expect, test } from 'bun:test'
import { generateKeyPairSync, sign } from 'node:crypto'
import { wellKnownProofMessage } from '../../../../packages/kybern-client/src/machineRoutes.ts'
import { verifyMachineProof } from './proof.ts'

function signed(parts = { nonce: 'n1', machineId: 'm1', at: '2026-10-28T10:00:00Z', host: '100.64.0.2:4173' }) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const message = wellKnownProofMessage(parts)
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
  return { ...parts, message, signingKey: Buffer.from(raw).toString('base64'), proof: sign(null, message, privateKey).toString('base64') }
}

test('an Ed25519 identity proof verifies against the key that signed it, and nothing else', () => {
  const input = signed()
  expect(verifyMachineProof(input)).toBe(true)
  expect(verifyMachineProof({ ...input, message: wellKnownProofMessage({ ...input, nonce: 'n2' }) })).toBe(false)
  expect(verifyMachineProof({ ...input, signingKey: signed().signingKey })).toBe(false)
  expect(verifyMachineProof({ ...input, proof: 'AAAA' })).toBe(false)
  expect(verifyMachineProof({ ...input, signingKey: 'short' })).toBe(false)
})
