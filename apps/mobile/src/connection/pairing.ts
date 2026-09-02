// Pairing links: `kybern://pair?url=ws%3A%2F%2Fhost%3A4173%2Fws&token=...`
// The daemon's default port is 4173 and the socket path is `/ws`.

import { DEFAULT_PORT, type Endpoint } from "@/protocol";

export interface ParsedPairing {
  url: string;
  token: string;
}

/** Returns null when the link is not a pairing link or lacks a field. */
export function parsePairingUrl(link: string): ParsedPairing | null {
  const m = /^kybern:\/\/pair(?:\/)?(?:\?(.*))?$/i.exec(link.trim());
  if (!m) return null;
  const query = m[1] ?? "";
  const params = new Map<string, string>();
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const k = decodeURIComponent(eq === -1 ? pair : pair.slice(0, eq));
    const v = decodeURIComponent(eq === -1 ? "" : pair.slice(eq + 1).replace(/\+/g, " "));
    params.set(k, v);
  }
  const url = params.get("url");
  const token = params.get("token");
  if (!url || !token) return null;
  const normalized = normalizeDaemonUrl(url);
  if (!normalized) return null;
  return { url: normalized, token };
}

/**
 * Accepts `host`, `host:port`, `ws://host:port`, `ws://host:port/ws`,
 * `http(s)://...`. Returns a `ws(s)://host:port/ws` URL or null.
 */
export function normalizeDaemonUrl(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  if (!/^[a-z]+:\/\//i.test(s)) s = `ws://${s}`;
  s = s.replace(/^http:\/\//i, "ws://").replace(/^https:\/\//i, "wss://");
  const m = /^(wss?):\/\/([^/?#]+)(\/[^?#]*)?(\?[^#]*)?$/i.exec(s);
  if (!m) return null;
  const scheme = m[1]?.toLowerCase();
  let hostPort = m[2] ?? "";
  let path = m[3] ?? "";
  if (!hostPort) return null;
  // IPv6 literal or plain host: add the default port when none is given.
  const hasPort = hostPort.startsWith("[") ? /\]:\d+$/.test(hostPort) : /:\d+$/.test(hostPort);
  if (!hasPort) hostPort = `${hostPort}:${DEFAULT_PORT}`;
  if (path === "" || path === "/") path = "/ws";
  return `${scheme}://${hostPort}${path}`;
}

export function endpointFromForm(url: string, token: string): Endpoint | null {
  const normalized = normalizeDaemonUrl(url);
  const t = token.trim();
  if (!normalized || !t) return null;
  return { url: normalized, token: t };
}
