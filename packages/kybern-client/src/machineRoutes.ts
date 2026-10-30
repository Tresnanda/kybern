// Routes to a machine: ordering, the plain-HTTP rules, relay routes, and the
// well-known identity check that must pass before any credential is sent to an
// address (machine-network design §3.2 and §3.4). Pure; no sockets, no timers.
import { httpBase } from "./address.ts";
import type { MachineId, Route, RouteKind } from "./types.ts";

/** Tried in this order: tailnet, advertised HTTPS, a saved SSH tunnel, then a relay through a member. */
const KIND_RANK: Record<RouteKind, number> = {
  direct_tailnet: 0,
  direct_advertised: 1,
  ssh: 2,
  relay: 3,
};

/** The most routes kept per machine, learned and configured together. */
export const MAX_ROUTES_PER_MACHINE = 12;
/** An `at` further than this from the client's clock fails the identity check. */
export const WELL_KNOWN_MAX_SKEW_MS = 60_000;
export const WELL_KNOWN_PATH = "/.well-known/kybern/machine";
export const WELL_KNOWN_PROOF_PREFIX = "kybern-wk-v1\0";

// ---- hosts and the plain-HTTP rule ----

export type HostClass = "loopback" | "tailnet" | "private" | "public";

function ipv4(host: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return undefined;
  const octets = m.slice(1).map(Number);
  return octets.every((n) => n <= 255) ? octets : undefined;
}

/** Where a host name or address lives, as far as the address alone can tell. */
export function classifyHost(hostname: string): HostClass {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  const v4 = ipv4(host);
  if (v4) {
    const [a, b] = v4 as [number, number];
    if (a === 127) return "loopback";
    if (a === 100 && b >= 64 && b <= 127) return "tailnet";
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254))
      return "private";
    return "public";
  }
  if (host.includes(":")) {
    if (host === "::1") return "loopback";
    if (host.startsWith("fd7a:115c:a1e0:")) return "tailnet";
    if (/^f[cd][0-9a-f]{2}:/.test(host) || host.startsWith("fe80:")) return "private";
    return "public";
  }
  if (host === "localhost" || host.endsWith(".localhost")) return "loopback";
  if (host.endsWith(".ts.net")) return "tailnet";
  // A single label is a MagicDNS or LAN name; `.local` is mDNS.
  if (!host.includes(".") || host.endsWith(".local") || host.endsWith(".lan")) return "private";
  return "public";
}

function parse(url: string): URL | undefined {
  try {
    return new URL(url.includes("://") ? url : `ws://${url}`);
  } catch {
    return undefined;
  }
}

/** Why a route may not carry a credential; `undefined` when it may. */
export function routeRefusal(route: Route): string | undefined {
  const url = parse(route.url);
  if (!url) return "This address is not valid";
  if (url.username || url.password || url.search || url.hash)
    return "Use an address without credentials or query parameters";
  const secure = url.protocol === "https:" || url.protocol === "wss:";
  const plain = url.protocol === "http:" || url.protocol === "ws:";
  if (!secure && !plain) return "Use an http, https, ws or wss address";
  const where = classifyHost(url.hostname);
  // A saved SSH tunnel is a local forward: the credential never leaves the machine in the clear.
  if (route.kind === "ssh" && where !== "loopback") return "An SSH route must point at the local end of the tunnel";
  if (plain && where === "public") return "Public addresses must use HTTPS or an encrypted tunnel";
  return undefined;
}

export function routeAllowed(route: Route): boolean {
  return routeRefusal(route) === undefined;
}

/** 3 s on this computer, 10 s anywhere else (design §3.2). */
export function probeTimeoutMs(route: Route): number {
  const url = parse(route.url);
  return url && classifyHost(url.hostname) === "loopback" ? 3_000 : 10_000;
}

// ---- route identity and order ----

function base(url: string): string {
  try {
    return httpBase(url);
  } catch {
    return url;
  }
}

/** Stable identity of a route: its kind, normalized address and relay member. */
export function routeId(route: Route): string {
  return `${route.kind}|${base(route.url)}|${route.via ?? ""}`;
}

/** Order routes by kind, keeping the given order within a kind, and drop repeats. */
export function orderRoutes(...lists: readonly (readonly Route[] | undefined)[]): Route[] {
  const seen = new Set<string>();
  const all: Route[] = [];
  for (const list of lists)
    for (const route of list ?? []) {
      const id = routeId(route);
      if (seen.has(id)) continue;
      seen.add(id);
      all.push(route);
    }
  return all
    .map((route, index) => ({ route, index }))
    .sort((a, b) => KIND_RANK[a.route.kind] - KIND_RANK[b.route.kind] || a.index - b.index)
    .map((entry) => entry.route);
}

/** The route a client reaches `target` through when it goes via member `via` at `viaUrl`. */
export function relayRoute(viaUrl: string, via: MachineId, target: MachineId): Route {
  return { kind: "relay", url: `${base(viaUrl)}/relay/${encodeURIComponent(target)}`, via };
}

/** Where the unauthenticated identity document of a route is served. */
export function wellKnownUrl(route: Route, nonce: string): string {
  const at = route.kind === "relay" ? `/http${WELL_KNOWN_PATH}` : WELL_KNOWN_PATH;
  return `${base(route.url)}${at}?nonce=${encodeURIComponent(nonce)}`;
}

/** The `host` the proof covers: the authority the client asked for. */
export function routeHost(route: Route): string {
  return parse(route.url)?.host ?? "";
}

// ---- the well-known identity check ----

/** What `GET /.well-known/kybern/machine` answers. */
export interface WellKnownAnswer {
  machine_id: MachineId;
  name: string;
  os: string;
  arch?: string;
  version?: string;
  network_protocol?: number;
  features?: string[];
  /** Ed25519 public key, standard base64. */
  signing_key: string;
  sealing_key?: string;
  network_id?: string | null;
  ts_name?: string | null;
  /** The daemon's clock, RFC 3339. */
  at: string;
  /** Ed25519 signature, standard base64. */
  proof: string;
}

export interface ProofInput {
  signingKey: string;
  proof: string;
  nonce: string;
  machineId: MachineId;
  at: string;
  host: string;
  /** `"kybern-wk-v1\0" || nonce || machine_id || at || host` as UTF-8, with no separators. */
  message: Uint8Array;
}

const encoder = new TextEncoder();

/** The bytes the daemon signs. Concatenated as UTF-8 text, nonce as the base64url string the client sent. */
export function wellKnownProofMessage(parts: { nonce: string; machineId: string; at: string; host: string }): Uint8Array {
  return encoder.encode(
    WELL_KNOWN_PROOF_PREFIX + parts.nonce + parts.machineId + parts.at + parts.host,
  );
}

export type WellKnownFailure =
  /** The address answered as another machine, or with another key. Fatal for the route. */
  | "different_machine"
  /** The proof does not verify against the key. Fatal for the route. */
  | "bad_proof"
  /** `at` is not within 60 s of this clock. Not an identity failure; retry later. */
  | "stale";

export type WellKnownCheck =
  | { ok: true; signingKey: string; answer: WellKnownAnswer }
  | { ok: false; reason: WellKnownFailure; fatal: boolean };

export interface WellKnownContext {
  nonce: string;
  host: string;
  now: number;
  expected: { machineId: MachineId; /** The pinned key, when there is one. */ signingKey?: string };
  verifyProof(input: ProofInput): boolean | Promise<boolean>;
  maxSkewMs?: number;
}

/**
 * The checks a route must pass before a token, grant or offer is sent to it:
 * the machine id is the expected one, the key is the pinned one, `at` is fresh
 * and the proof over our nonce verifies against that key. With no pinned key
 * the answer's own key is accepted and returned so the caller can pin it.
 */
export async function checkWellKnown(answer: unknown, ctx: WellKnownContext): Promise<WellKnownCheck> {
  const a = answer as Partial<WellKnownAnswer> | null;
  if (
    !a ||
    typeof a.machine_id !== "string" ||
    typeof a.signing_key !== "string" ||
    typeof a.proof !== "string" ||
    typeof a.at !== "string"
  )
    return { ok: false, reason: "different_machine", fatal: true };
  if (a.machine_id !== ctx.expected.machineId) return { ok: false, reason: "different_machine", fatal: true };
  if (ctx.expected.signingKey && a.signing_key !== ctx.expected.signingKey)
    return { ok: false, reason: "different_machine", fatal: true };
  const at = Date.parse(a.at);
  if (!Number.isFinite(at) || Math.abs(at - ctx.now) > (ctx.maxSkewMs ?? WELL_KNOWN_MAX_SKEW_MS))
    return { ok: false, reason: "stale", fatal: false };
  let verified = false;
  try {
    verified = await ctx.verifyProof({
      signingKey: a.signing_key,
      proof: a.proof,
      nonce: ctx.nonce,
      machineId: a.machine_id,
      at: a.at,
      host: ctx.host,
      message: wellKnownProofMessage({ nonce: ctx.nonce, machineId: a.machine_id, at: a.at, host: ctx.host }),
    });
  } catch {
    verified = false;
  }
  if (!verified) return { ok: false, reason: "bad_proof", fatal: true };
  return { ok: true, signingKey: a.signing_key, answer: a as WellKnownAnswer };
}

/** What the UI says when a route is blocked for answering as someone else. */
export const IDENTITY_MISMATCH_MESSAGE = "This address answered as a different machine";
