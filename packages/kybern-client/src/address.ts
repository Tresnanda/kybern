import { DEFAULT_PORT } from "./types.ts";

export function normalizeDaemonUrl(input: string): string {
  const value = input.trim();
  if (!value) throw new Error("Enter the environment address");
  const explicit = value.includes("://");
  const url = new URL(explicit ? value : `ws://${value}`);
  if (
    !["ws:", "wss:", "http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Use a server address without credentials or query parameters",
    );
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
