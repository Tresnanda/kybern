import { lease } from '../memory/lease.ts'
import { onExit } from '../bench/lifetime.ts'
const release = await lease(), leave = onExit(release)
try { await import('./verify.ts') }
finally { release(); leave() }
