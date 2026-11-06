import { DEFAULT_PORT } from "./types.ts";

/** What a person types for a computer: its name or IP address, with a port only when it is not the usual one. */
const ADDRESS_EXAMPLE_PROMPT = "Enter the computer's address, like 192.168.1.20 or my-pc.tailnet.ts.net";
export const INVALID_ADDRESS = "That isn't a valid address. Enter the computer's name or IP address, like 192.168.1.20";
const UNSUPPORTED_ADDRESS = "Use just the computer's address, without a user name, password or query, like 192.168.1.20";

export function normalizeDaemonUrl(input: string): string {
  const value = input.trim();
  if (!value) throw new Error(ADDRESS_EXAMPLE_PROMPT);
  const explicit = value.includes("://");
  let url: URL;
  try {
    url = new URL(explicit ? value : `ws://${value}`);
  } catch {
    // The platform says "Invalid URL"; say what to fix instead.
    throw new Error(INVALID_ADDRESS);
  }
  if (
    !["ws:", "wss:", "http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(UNSUPPORTED_ADDRESS);
  }
  url.protocol =
    url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  if (!explicit && !url.port) url.port = String(DEFAULT_PORT);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/ws") ? path : `${path}/ws`;
  return url.toString();
}

export function httpBase(url: string): string {
  return normalizeDaemonUrl(url).replace(/^ws/, "http").replace(/\/ws$/, "");
}

export interface PairingInvitation {
  url: string;
  code: string;
  environmentId?: string;
}

export function parsePairingInvitation(
  value: string,
): PairingInvitation | null {
  try {
    const link = new URL(value);
    if (link.protocol !== "kybern:" || link.hostname !== "pair") return null;
    const code = link.searchParams.get("code") ?? "";
    if (!/^\d{6}$/.test(code)) return null;
    return {
      url: normalizeDaemonUrl(link.searchParams.get("url") ?? ""),
      code,
      environmentId: link.searchParams.get("environment") ?? undefined,
    };
  } catch {
    return null;
  }
}

export function pairingInvitation(
  url: string,
  code: string,
  environmentId: string,
): string {
  return `kybern://pair?${new URLSearchParams({ url: normalizeDaemonUrl(url), code, environment: environmentId })}`;
}
