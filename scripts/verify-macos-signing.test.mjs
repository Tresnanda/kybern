import { test } from 'node:test'
import assert from 'node:assert/strict'
import { signingIdentity, verifyIdentities } from './verify-macos-signing.mjs'

const signed = (identifier, team = 'TESTTEAM01') => signingIdentity(`Identifier=${identifier}
Authority=Developer ID Application: Test (${team})
Authority=Developer ID Certification Authority
TeamIdentifier=${team}
designated => identifier "${identifier}" and anchor apple generic and certificate leaf[subject.OU] = "${team}"`)
const adhoc = (identifier) => signingIdentity(`Identifier=${identifier}
Signature=adhoc
TeamIdentifier=not set
# designated => cdhash H"012345"`)

test('app and sidecar retain a compatible certificate identity', () => {
  assert.equal(verifyIdentities(signed('dev.kybern.desktop'), signed('kybernd')), 'certificate')
})

test('an ad-hoc fallback cannot silently replace requested certificate signing', () => {
  const app = adhoc('dev.kybern.desktop'), daemon = adhoc('kybernd')
  assert.throws(() => verifyIdentities(app, daemon), /certificate/)
  assert.equal(verifyIdentities(app, daemon, true), 'adhoc')
  assert.throws(() => verifyIdentities(signed('dev.kybern.desktop'), daemon, true), /certificate/)
})

test('rejects a changed bundle identifier, signer team or build-hash requirement', () => {
  assert.throws(() => verifyIdentities(signed('dev.other'), signed('kybernd')), /identifier/)
  assert.throws(() => verifyIdentities(signed('dev.kybern.desktop'), signed('kybernd', 'DIFFERENT')), /same signing team/)
  assert.throws(() => verifyIdentities({ ...signed('dev.kybern.desktop'), requirement: 'cdhash H"123"' }, signed('kybernd')), /build hash/)
  assert.throws(() => verifyIdentities({ ...signed('dev.kybern.desktop'), requirement: '' }, signed('kybernd')), /build hash/)
})
