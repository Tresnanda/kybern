// A forwarded page on a slow link (ADE-126). The daemon counts what each forward fetches for the page loading now
// (`PortForward.loading`, repeated by `ports.changed` once a second after two seconds), so a page that keeps its content
// hidden until it has loaded looks slow instead of broken, and says which member its connections go through.
import type { PortForward, PortLoad } from '../../../../packages/kybern-client/src/types.ts'
import { shortMachineName } from '../../../../packages/kybern-client/src/forkMachine.ts'

/** A load shows as slow only after this long. */
export const SLOW_AFTER_MS = 3000

/** The forward that serves a page from another machine. */
export function forwardOf(forwards: readonly PortForward[], machine: { id: string; port: number } | undefined): PortForward | undefined {
  return machine ? forwards.find(f => f.machine_id === machine.id && f.remote_port === machine.port) : undefined
}

const mb = (bytes: number) => { const value = bytes / 1e6; return value >= 10 ? Math.round(value).toString() : value.toFixed(1) }

/** `4.2 of 31 MB`, `850 KB`, `4.2 MB`. */
export function amount(done: number, total?: number): string {
  if (total && total > done) return `${mb(done)} of ${mb(total)} MB`
  return done >= 1e6 ? `${mb(done)} MB` : `${Math.max(1, Math.round(done / 1e3))} KB`
}

/** `90 KB/s`, `2.4 MB/s`. */
export function rate(bytesPerSecond: number): string {
  return bytesPerSecond >= 1e6 ? `${(bytesPerSecond / 1e6).toFixed(1)} MB/s` : `${Math.round(bytesPerSecond / 1e3)} KB/s`
}

/** What the Browser says while a page still loads after `SLOW_AFTER_MS` with bytes arriving, else null. */
export function slowLoadText(load: PortLoad | undefined): string | null {
  if (!load || load.open_requests === 0 || load.elapsed_ms < SLOW_AFTER_MS || load.received_bytes === 0) return null
  const done = load.received_bytes + (load.cached_bytes ?? 0)
  return `Loading over a slow connection — ${amount(done, load.expected_bytes)} · ${rate(load.bytes_per_second)}`
}

/** `via kdi-vps` when the forward's connections go through another member. */
export function routeText(forward: Pick<PortForward, 'route_via'> | undefined): string | null {
  const via = forward?.route_via
  return via ? `via ${shortMachineName(via.machine_name) || via.machine_name}` : null
}
