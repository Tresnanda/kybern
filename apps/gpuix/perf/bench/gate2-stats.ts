/**
 * Statistics and schedule for the interleaved translucency gate (`perf/translucency-zeron-research.md` §5).
 * Pure functions only; `gate2.ts` runs the matrix and `gate2-report.ts` prints the tables.
 */
export type Rnd = () => number
/** Deterministic PRNG so a schedule and a bootstrap can be reproduced from the seed in the label. */
export const mulberry32 = (seed: number): Rnd => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
export const shuffle = <T>(items: readonly T[], rnd: Rnd): T[] => {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [out[i], out[j]] = [out[j]!, out[i]!] }
  return out
}
export const median = (values: readonly number[]): number | null => {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b), m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

export type Pass = { round: number; arm: string; scenarios: string[] }
/**
 * Rounds of every arm. Odd rounds use a seeded shuffle of the arms, even rounds the reverse of the previous one, so a
 * linear drift cancels (A B B A). Scenario order inside each pass is a fresh seeded shuffle.
 */
export function plan(arms: readonly string[], scenarios: readonly string[], rounds: number, seed: number): Pass[] {
  const rnd = mulberry32(seed), out: Pass[] = []
  let order = [...arms]
  for (let round = 1; round <= rounds; round++) {
    order = round % 2 ? shuffle(arms, rnd) : [...order].reverse()
    for (const arm of order) out.push({ round, arm, scenarios: shuffle(scenarios, rnd) })
  }
  return out
}

/** Percentile bootstrap of the median of paired deltas; the resampling unit is the block (round), never the window. */
export function bootstrap(deltas: readonly number[], seed: number, level = 0.9, resamples = 10000): { est: number; lo: number; hi: number; n: number } | null {
  if (!deltas.length) return null
  const rnd = mulberry32(seed), n = deltas.length, meds: number[] = []
  for (let i = 0; i < resamples; i++) meds.push(median(Array.from({ length: n }, () => deltas[Math.floor(rnd() * n)]!))!)
  meds.sort((a, b) => a - b)
  const at = (p: number) => meds[Math.min(meds.length - 1, Math.max(0, Math.floor(p * meds.length)))]!
  return { est: median(deltas)!, lo: at((1 - level) / 2), hi: at(1 - (1 - level) / 2), n }
}

/** Submission counts that differ by more than 10% (relative to the base) make a pair invalid. */
export const sameCadence = (a: number, b: number, tolerance = 0.1) => b > 0 ? Math.abs(a - b) / b <= tolerance : a === b

export type Verdict = 'pass' | 'unresolved' | 'FAIL' | 'uninformative' | 'insufficient'
/**
 * A metric fails only when the CI's lower bound exceeds the threshold. It is uninformative for the session when the A/A
 * pair's own CI reaches the threshold, and insufficient with fewer than three valid blocks.
 */
export function verdict(ci: { est: number; lo: number; hi: number; n: number } | null, threshold: number, aa: { hi: number } | null): Verdict {
  if (!ci || ci.n < 3) return 'insufficient'
  if (aa && aa.hi > threshold) return 'uninformative'
  if (ci.lo > threshold) return 'FAIL'
  return ci.hi <= threshold ? 'pass' : 'unresolved'
}
