// Which permission modes a harness lets a chat use. Antigravity (`agy`) on its `-p` transport runs every turn with its
// permission prompts off, so the daemon only accepts Full access for it and both apps lock the picker (ADE-111). On ACP
// (agy 1.5 or later) Kybern answers its permission requests and its status reports every mode, which unlocks the picker.
// Driven by the harness's reported modes when known, with the kind as the fallback.
import { ANTIGRAVITY_FULL_ACCESS_NOTE } from "./antigravity.ts";
import type { PermissionMode, ProviderKind, ProviderStatus } from "./types.ts";

export { ANTIGRAVITY_FULL_ACCESS_NOTE };

/** The harness only runs in Full access, so its picker is locked. */
export function onlyFullAccess(harness: ProviderKind | Pick<ProviderStatus, "kind" | "supported_permission_modes"> | null | undefined): boolean {
  if (!harness) return false;
  if (typeof harness === "string") return harness === "antigravity";
  const modes = harness.supported_permission_modes;
  if (modes && modes.length === 1 && modes[0] === "full-access") return true;
  // An Antigravity that reports more than Full access runs on ACP and asks before acting.
  return harness.kind === "antigravity" && !(modes && modes.length > 1);
}

/** The note under a locked picker, or null when the picker is free. */
export function permissionLockNote(harness: ProviderKind | Pick<ProviderStatus, "kind" | "supported_permission_modes"> | null | undefined): string | null {
  const kind = typeof harness === "string" ? harness : harness?.kind;
  return kind === "antigravity" && onlyFullAccess(harness) ? ANTIGRAVITY_FULL_ACCESS_NOTE : null;
}

/** `mode` limited to what the harness accepts: Full access for a locked harness, otherwise unchanged. */
export function permissionModeFor(harness: ProviderKind | Pick<ProviderStatus, "kind" | "supported_permission_modes"> | null | undefined, mode: PermissionMode): PermissionMode {
  return onlyFullAccess(harness) ? "full-access" : mode;
}

/** The modes the picker offers for a harness. */
export function permissionModesFor(harness: ProviderKind | Pick<ProviderStatus, "kind" | "supported_permission_modes">, all: readonly PermissionMode[]): PermissionMode[] {
  return onlyFullAccess(harness) ? ["full-access"] : [...all];
}
