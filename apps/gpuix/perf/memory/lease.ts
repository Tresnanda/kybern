import { lease as queuedLease } from '../bench/lease.ts'
import { nativeBuildMarkers, quietMarkers } from '../bench/build-overlap.ts'
import { processInventory } from '../bench/process-gate.ts'

const foreignQuiet = () => quietMarkers().some(marker => marker !== 'kybern-gpuix-quiet.perf-memory')

/** A build may start while this request waits behind another window. */
export async function lease() {
  for (;;) {
    while (foreignQuiet() || nativeBuildMarkers().length || processInventory().foreign.length) await Bun.sleep(1000)
    const release = await queuedLease()
    if (!foreignQuiet() && !nativeBuildMarkers().length && !processInventory().foreign.length) return release
    release()
    await Bun.sleep(1000)
  }
}
