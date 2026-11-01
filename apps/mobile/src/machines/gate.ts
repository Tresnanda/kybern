// The version gate for the machine-network controls added in ADE-99 (design: docs/design/ade-99-mobile-network.md §0).
// The phone ships these screens to every install through an update, but the daemons they call may be older. A control
// that acts through a machine shows only when that machine runs 0.21.0 or newer; otherwise it is hidden, not disabled.
import { versionAtLeast } from "../../../../packages/kybern-client/src/newChat";

export const NETWORK_PARITY_MIN_VERSION = "0.21.0";

/** A daemon version, a connection or a daemon info: anything that carries the version of the machine it describes. */
export type ParitySubject = string | { version?: string | null } | { info?: { version?: string | null } | null } | null | undefined;

/**
 * Local testing against a 0.20.x scratch daemon: `EXPO_PUBLIC_KYBERN_PARITY_GATE=off`. Read in development builds only,
 * so a shipped app can never turn the gate off.
 */
export function gateDisabled(): boolean {
  if (typeof __DEV__ === "undefined" || !__DEV__) return false;
  return process.env.EXPO_PUBLIC_KYBERN_PARITY_GATE === "off";
}

export function versionOf(subject: ParitySubject): string | undefined {
  if (!subject) return undefined;
  if (typeof subject === "string") return subject;
  if ("info" in subject) return subject.info?.version ?? undefined;
  return (subject as { version?: string | null }).version ?? undefined;
}

/** True when the machine described by `subject` is new enough for the network controls. `off` is for tests. */
export function parityOn(subject: ParitySubject, off: boolean = gateDisabled()): boolean {
  return off || versionAtLeast(versionOf(subject), NETWORK_PARITY_MIN_VERSION);
}

/** "Update Kybern on satyamas to 0.21 to manage more of your network here." for the first of the older members, or null. */
export function parityFooter(olderNames: readonly string[]): string | null {
  const [first] = olderNames;
  return first ? `Update Kybern on ${first} to 0.21 to manage more of your network here.` : null;
}
