import { startDaemon, seed, readState } from './fixture.ts'
const s = await startDaemon(process.argv.includes('--fresh'))
if (!s.seeded) await seed(s)
console.log(JSON.stringify(readState()))
process.exit(0)
