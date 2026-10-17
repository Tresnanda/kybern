// Run under verify.fixture.ts. Separate processes exercise the real exit flush.
import assert from 'node:assert/strict'
import { connect } from '../state.ts'
import { startLive } from '../nav/live.ts'
import { getNav, setNav } from '../nav/store.ts'
import { environmentKey } from './environment.ts'
assert.equal(environmentKey(), process.env.KYBERN_DATA_DIR)
connect(); startLive()
if (process.argv[2] === 'write') {
  setNav({ unread: { 'fixture-thread': true }, attentionDismissals: { 'fixture-thread': 123 } })
  process.exit(0)
}
assert.deepEqual(getNav().unread, { 'fixture-thread': true })
assert.deepEqual(getNav().attentionDismissals, { 'fixture-thread': 123 })
console.log('PASS unread and attention dismissals persisted across process exit')
process.exit(0)
