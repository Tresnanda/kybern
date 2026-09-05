import type { Endpoint } from "@/protocol";
import { normalizeDaemonUrl as normalize, parsePairingInvitation, httpBase } from "../../../../packages/kybern-client/src/address";

export const parsePairingUrl = parsePairingInvitation;

export function normalizeDaemonUrl(input: string): string | null {
  try { return normalize(input); } catch { return null; }
}

export function endpointFromForm(url: string, token: string): Endpoint | null {
  const normalized = normalizeDaemonUrl(url);
  if (!normalized || !token.trim()) return null;
  return { url: normalized, token: token.trim() };
}

export async function redeemPairing(url: string, code: string, environmentId?: string): Promise<Endpoint> {
  const normalized = normalize(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(httpBase(normalized) + "/pair", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, device_name: "Kybern mobile" }),
      signal: controller.signal, redirect: "error",
    });
    if (!response.ok) throw new Error("Pairing failed. Create a new invitation on the host.");
    const result = await response.json() as { token: string; environment_id: string };
    if (environmentId && environmentId !== result.environment_id) throw new Error("The invitation belongs to a different environment.");
    return { url: normalized, token: result.token, environmentId: result.environment_id };
  } finally { clearTimeout(timer); }
}
