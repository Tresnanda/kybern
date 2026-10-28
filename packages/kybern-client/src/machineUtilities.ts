// The machine utilities' wording and rules (M4 / U1 Files, U3 Ports; design §8.1, §8.3). Pure and shared by the GPUIX and mobile
// clients: who a file can be sent to, how a send reads while it runs, the notice for received files, how a forward reads, and the
// route a relayed preview page loads from.

import type { MachineSummary } from "./machines.ts";
import type {
  FilesProgress,
  FilesReceived,
  MachineId,
  OutboxItem,
  PortForward,
  PushDest,
} from "./types.ts";
import { MAX_PUSH_BYTES } from "./types.ts";

/** `1.5 MiB`, `812 KiB`, `3 B`. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / 2 ** 30).toFixed(1)} GiB`;
  if (bytes >= 1 << 20) return `${(bytes / 2 ** 20).toFixed(1)} MiB`;
  if (bytes >= 1 << 10) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} B`;
}

export interface SendTarget {
  machineId: MachineId;
  name: string;
  /** Online machines receive at once; an offline one gets the files when it returns. */
  online: boolean;
  /** The row's second line. */
  detail: string;
}

/** The machines a file can be sent to, in the app's order: every other machine that is not paused. */
export function sendTargets(machines: readonly Pick<MachineSummary, "machineId" | "name" | "status" | "isLocal">[]): SendTarget[] {
  return machines
    .filter((machine) => !machine.isLocal && machine.status !== "paused" && machine.status !== "unpaired")
    .map((machine) => {
      const online = machine.status === "online" || machine.status === "relaying" || machine.status === "needs-update";
      return {
        machineId: machine.machineId,
        name: machine.name,
        online,
        detail: online ? "Online" : "Offline · sends when it returns",
      };
    });
}

/** Whether a send of this many bytes is allowed. */
export function sendTooLarge(bytes: number): boolean {
  return bytes > MAX_PUSH_BYTES;
}

/** Where a send lands, in words. */
export function destLabel(dest: PushDest | null | undefined, machineName: string): string {
  if (!dest || dest.kind === "downloads") return `${machineName} · Downloads/Kybern`;
  return dest.subdir ? `${machineName} · ${dest.project}/${dest.subdir}` : `${machineName} · ${dest.project}`;
}

export type SendPhase = "waiting" | "sending" | "sent" | "failed" | "cancelled";

export interface SendStatus {
  phase: SendPhase;
  /** One line for a row or a toast. */
  text: string;
  /** 0–1 while sending with a known total. */
  fraction?: number;
}

/** How a `files_push` outbox item reads, with the latest progress notification for it when there is one. */
export function sendStatus(item: Pick<OutboxItem, "state" | "last_error" | "result">, machineName: string, progress?: FilesProgress | null): SendStatus {
  switch (item.state) {
    case "queued":
      return { phase: "waiting", text: item.last_error ? `Waiting for ${machineName} · ${item.last_error}` : `Waiting for ${machineName}` };
    case "sending": {
      const fraction = progress && progress.total > 0 ? Math.min(1, progress.sent / progress.total) : undefined;
      const text = progress && progress.total > 0
        ? `Sending to ${machineName} · ${formatBytes(progress.sent)} of ${formatBytes(progress.total)}`
        : `Sending to ${machineName}`;
      return { phase: "sending", text, ...(fraction === undefined ? {} : { fraction }) };
    }
    case "delivered": {
      const path = (item.result as { dest_path?: string } | null | undefined)?.dest_path;
      return { phase: "sent", text: path ? `Sent to ${machineName} · ${path}` : `Sent to ${machineName}` };
    }
    case "cancelled":
      return { phase: "cancelled", text: `Cancelled · not sent to ${machineName}` };
    case "failed":
    case "expired":
      return { phase: "failed", text: item.last_error ?? `Could not send to ${machineName}` };
  }
}

export interface ReceivedNotice {
  title: string;
  description: string;
  /** The folder (or file) to show in the file manager. */
  path: string;
}

/** The notice for files that arrived from another machine. */
export function receivedNotice(received: FilesReceived): ReceivedNotice {
  const what = received.files === 1 ? received.name : `${received.name} (${received.files} files)`;
  return {
    title: `${what} from ${received.from_name}`,
    description: `${formatBytes(received.bytes)} · ${received.dest_path}`,
    path: received.dest_path,
  };
}

/** A forward in the Ports menu. */
export function portLabel(forward: Pick<PortForward, "machine_name" | "remote_port" | "local_port" | "connections">): string {
  const open = forward.connections > 0 ? ` · ${forward.connections} open` : "";
  return `${forward.machine_name}:${forward.remote_port} → localhost:${forward.local_port}${open}`;
}

const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

/** The path of a preview ticket on another machine, reached through the machine you are paired with. */
export function relayedPreviewPath(machineId: MachineId, ticket: string): string | null {
  return SAFE_SEGMENT.test(machineId) && SAFE_SEGMENT.test(ticket) ? `/relay/${machineId}/http/preview-proxy/${ticket}/` : null;
}

export type NoticeKind = "info" | "success" | "warning" | "error";

/** How a send's toast looks for a status: a progress bar while sending, and when it should leave. */
export function sendToastShape(status: SendStatus): { kind: NoticeKind; progress?: number; duration: number } {
  switch (status.phase) {
    case "sending":
      return { kind: "info", ...(status.fraction === undefined ? {} : { progress: status.fraction }), duration: Number.POSITIVE_INFINITY };
    case "waiting":
      return { kind: "info", duration: 8000 };
    case "sent":
      return { kind: "success", duration: 6000 };
    case "cancelled":
      return { kind: "warning", duration: 6000 };
    case "failed":
      return { kind: "error", duration: 10000 };
  }
}

/** Whether a send has reached its end (the toast stops following it). */
export const sendFinished = (status: SendStatus): boolean => status.phase === "sent" || status.phase === "failed" || status.phase === "cancelled";

export interface TerminalMachine {
  machineId: MachineId;
  name: string;
}

/** The machines a terminal can open on besides this thread's own: reachable ones only (a terminal needs a live shell). */
export function terminalMachines(
  machines: readonly Pick<MachineSummary, "machineId" | "name" | "status">[],
  own: MachineId | null | undefined,
): TerminalMachine[] {
  return machines
    .filter((machine) => machine.machineId !== own && (machine.status === "online" || machine.status === "relaying" || machine.status === "needs-update"))
    .map(({ machineId, name }) => ({ machineId, name }));
}

/** A remote terminal's tab tooltip. */
export const terminalTooltip = (machineName: string, title?: string): string => (title ? `${title} · on ${machineName}` : `Terminal on ${machineName}`);
