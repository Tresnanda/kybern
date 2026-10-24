// Words for the values Settings shows. Pure, so the pages never print a raw enum
// and the rules are testable.
import type {
  AccountStatus,
  DaemonUpdate,
  HarnessUpdate,
  LimitsStale,
  PermissionMode,
  ProviderKind,
  ProviderUsage,
  Scope,
} from "../../state/protocol";

/** The composer's names for permission modes. */
export const PERMISSION_LABELS: Record<PermissionMode, string> = {
  supervised: "Ask before acting",
  "accept-edits": "Allow edits",
  auto: "Automatic",
  "full-access": "Full access",
};
export const permissionLabel = (mode: string) =>
  PERMISSION_LABELS[mode as PermissionMode] ?? "Ask before acting";

const DAEMON_UPDATE_LABELS: Record<DaemonUpdate["status"], string> = {
  not_checked: "Not checked",
  checking: "Checking…",
  current: "Up to date",
  available: "Update available",
  waiting: "Waiting to install",
  updating: "Updating…",
  restarting: "Restarting…",
  unsupported: "Not available",
  failed: "Update failed",
};
export const daemonUpdateLabel = (status: DaemonUpdate["status"]) =>
  DAEMON_UPDATE_LABELS[status] ?? "Not checked";

const HARNESS_UPDATE_LABELS: Record<HarnessUpdate["status"], string> = {
  not_checked: "Not checked",
  waiting: "Waiting",
  updating: "Updating…",
  updated: "Updated",
  current: "Up to date",
  unsupported: "Updates itself",
  failed: "Update failed",
};
export const harnessUpdateLabel = (status: HarnessUpdate["status"]) =>
  HARNESS_UPDATE_LABELS[status] ?? "Not checked";

const ACCOUNT_STATUS_LABELS: Record<AccountStatus, string> = {
  signed_in: "Signed in",
  needs_sign_in: "Needs sign-in",
  signed_out: "Signed out",
  unknown: "Status unknown",
};
export const accountStatusLabel = (status: AccountStatus) =>
  ACCOUNT_STATUS_LABELS[status] ?? "Status unknown";

/** True when the phone's token may read the Access settings (tokens, Tailscale). Code-paired phones may not. */
export function canManageAccess(scopes: readonly Scope[] | null | undefined) {
  return !!scopes?.includes("access_read");
}

export type Route = "This computer" | "Tailscale" | "Local network" | "Internet";

/** How the phone reaches the computer, from the address it uses. */
export function connectionRoute(url: string): Route {
  let host = "";
  try {
    host = new URL(url.replace(/^ws/, "http")).hostname.toLowerCase();
  } catch {
    return "Internet";
  }
  host = host.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || host.startsWith("127.")) return "This computer";
  if (host.endsWith(".ts.net")) return "Tailscale";
  const parts = host.split(".").map(Number);
  if (parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    const [a, b] = parts as [number, number, number, number];
    if (a === 100 && b >= 64 && b <= 127) return "Tailscale";
    if (a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254))
      return "Local network";
  }
  if (host.endsWith(".local") || host.startsWith("fd") || host.startsWith("fe80")) return "Local network";
  return "Internet";
}

/** "192.168.1.4:4199" from "ws://192.168.1.4:4199/ws". */
export const shortAddress = (url: string) =>
  url.replace(/^(wss?|https?):\/\//, "").replace(/\/ws$/, "").replace(/\/$/, "");

// ---- plan limits ----

type Limit = NonNullable<ProviderUsage["limits"]>[number];

/** Each vendor's own words for a limit window ("Current session", "This week"). */
export function limitLabel(limit: Limit, provider?: ProviderKind): string {
  const claude = provider === "claude-code";
  if (limit.window_minutes === 300) return claude ? "Current session" : "5-hour";
  if (limit.window_minutes === 10080) return claude ? "This week" : "Weekly";
  const name = limit.name?.trim();
  if (!name) return "Usage limit";
  if (name === "five_hour") return "5-hour";
  if (name === "seven_day") return "Weekly";
  if (name === "seven_day_overage_included") return "Weekly (with overage)";
  const words = name.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Usage limit";
}

/** 0–100, or null when the agent reported nonsense. */
export function usedPercent(limit: Limit): number | null {
  return Number.isFinite(limit.used_percent) ? Math.min(100, Math.max(0, limit.used_percent)) : null;
}

/** Colour only near a limit: 25 % left warns, 10 % left is critical. */
export function limitTone(percent: number | null): "accent" | "warning" | "negative" {
  if (percent === null || percent < 75) return "accent";
  return percent >= 90 ? "negative" : "warning";
}

/** "Resets in 2h 10m", "Resets in 3d 4h"; null without a reset time. */
export function resetsLabel(resetsAt: number | null, now: number): string | null {
  if (resetsAt == null) return null;
  const minutes = Math.round((resetsAt * 1000 - now) / 60_000);
  if (minutes <= 0) return "Resets soon";
  if (minutes < 60) return `Resets in ${minutes}m`;
  if (minutes < 1440) return `Resets in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `Resets in ${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
}

/** Why the numbers may be old, in plain words; null when they are live. */
export function staleLabel(stale: LimitsStale | undefined): string | null {
  switch (stale) {
    case "login_refresh":
      return "Sign in again on your computer to update these.";
    case "throttled":
      return "Updated less often for now.";
    case "unavailable":
      return "Couldn't read the latest numbers.";
    case "from_last_run":
      return "From the last run.";
    default:
      return null;
  }
}

/** Choices 1…max for a limit picker. */
export const rangeChoices = (min: number, max: number) =>
  Array.from({ length: max - min + 1 }, (_, i) => min + i);
