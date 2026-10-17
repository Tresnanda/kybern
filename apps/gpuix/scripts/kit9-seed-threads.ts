/** Seed the conversation/area fixtures (threads with transcripts) into this checkout's visual-pair scratch daemon. */
import { connect, readState } from '../visual/fixture.ts'
import { loadAreaFixtures } from '../visual/load.ts'
const state = readState()
if (!state) throw new Error('no scratch daemon: run `bun scripts/visual-pair.ts notes-gallery --keep` first')
const client = await connect(state)
for (const [name, f] of Object.entries(await loadAreaFixtures())) { await f.ids?.(client); console.log('seeded', name) }
process.exit(0)
