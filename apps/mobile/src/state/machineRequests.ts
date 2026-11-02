// Requests the phone makes itself to the machine that owns the thing: images, attachments, uploads
// and pages. A thread, an attachment or a space logo lives on one machine, which is not always the
// computer the phone is at, so the address, the token and (on a relay route) the relay member's
// header all come from that machine's client. This is the one place that builds such a request.
import { fetch as expoFetch } from "expo/fetch";
import type { KybernClient } from "../../../../packages/kybern-client/src/client";
import type { MachinePage } from "../machines/hub";
import type { MachineId } from "../../../../packages/kybern-client/src/types";
import { currentClient, machineHub } from "./runtime";

/** Who owns the thing a request is about: a listed thread's machine, an explicit machine, else the computer the phone is at. */
export interface RequestOwner {
  threadId?: string;
  machineId?: MachineId;
}

/** What an image loader, a download or a native upload needs. Never log it; it carries a credential. */
export interface RequestSource {
  uri: string;
  headers: Record<string, string>;
}

export interface AssetRef {
  id: string;
  name: string;
  media_type: string;
  size: number;
}

/** The machine an owner names. Undefined means the computer the phone is at. */
export function ownerMachine(owner: RequestOwner = {}): MachineId | undefined {
  if (owner.machineId) return owner.machineId;
  if (!owner.threadId) return undefined;
  return machineHub().machineOfThread(owner.threadId);
}

/**
 * The client of a machine: the phone's own connection for the computer it is at, else the hub's
 * connection to the other machine. Null while that machine cannot be reached.
 */
export function machineClient(machineId?: MachineId): KybernClient | null {
  const hub = machineHub();
  if (!machineId || machineId === hub.primaryMachineId || machineId === hub.localMachineId) return currentClient() ?? null;
  return hub.liveClientFor(machineId);
}

/** The client of the machine that owns `owner`. */
export function ownerClient(owner: RequestOwner = {}): KybernClient | null {
  return machineClient(ownerMachine(owner));
}

/** A request to `path` on the owner's machine. Undefined while it is offline. */
export function machineSource(path: string, owner: RequestOwner = {}): RequestSource | undefined {
  try {
    const request = ownerClient(owner)?.request(path);
    return request && { uri: request.url, headers: request.headers };
  } catch {
    return undefined;
  }
}

/** `/assets/<id>` on the owner's machine. */
export function assetSource(assetId: string, owner: RequestOwner = {}): RequestSource | undefined {
  return machineSource(`/assets/${encodeURIComponent(assetId)}`, owner);
}

/** An image a thread's agent mentions, resolved by that thread's machine against its folder. */
export function threadImageSource(threadId: string, path: string, machineId?: MachineId): RequestSource | undefined {
  return machineSource(`/threads/${encodeURIComponent(threadId)}/image?path=${encodeURIComponent(path)}`, { threadId, ...(machineId ? { machineId } : {}) });
}

/**
 * Upload a file as an attachment. It goes to the owner's machine; when that machine cannot be
 * reached (a queued send) it goes to the member the send queues on, which is the computer the
 * phone is at unless a network member is closer.
 */
export async function uploadAsset(
  body: Blob | { uri: string },
  meta: { name: string; mimeType?: string; signal?: AbortSignal },
  owner: RequestOwner = {},
): Promise<AssetRef> {
  const hub = machineHub();
  const client = ownerClient(owner) ?? hub.memberClient() ?? currentClient() ?? null;
  if (!client) throw new Error("Connect your computer, then attach the file again.");
  const request = client.request("/assets");
  const response = await expoFetch(request.url, {
    method: "POST",
    headers: {
      ...request.headers,
      "content-type": meta.mimeType ?? "application/octet-stream",
      "x-kybern-filename": encodeURIComponent(meta.name),
    },
    body: body as never,
    ...(meta.signal ? { signal: meta.signal } : {}),
  });
  if (!response.ok) throw new Error("Unable to attach this file. Check your connection and try again.");
  const result = (await response.json()) as AssetRef;
  const after = ownerClient(owner) ?? hub.memberClient() ?? currentClient() ?? null;
  if (after !== client) throw new Error("The connected computer changed. Attach the file again.");
  return result;
}

/** A ticket page of a machine, loadable by a WebView. */
export interface OwnedPage {
  url: string;
  /** Requests under this prefix stay in the WebView. Set for a relayed page; a direct page's is its own ticket root. */
  scope?: string;
  /** End the relay of a relayed page. The daemon's own ticket is closed by its owner (`closePreview`). */
  close(): void;
}

/**
 * Turn a ticket path (`/preview-proxy/<ticket>/`, `/visual-frame/<ticket>`, `/artifact-preview/<ticket>`)
 * the owner's machine returned into an address a WebView can load. A machine reached through a relay
 * serves the page through a ticket on the relay member, because a WebView cannot send the relay header.
 */
export async function openMachinePage(path: string, owner: RequestOwner = {}): Promise<OwnedPage> {
  const client = ownerClient(owner);
  if (!client) throw new Error("This machine is offline. Reconnect it, then try again.");
  const page = (await client.openPage(path)) as MachinePage;
  return { url: page.url, ...(page.scope ? { scope: page.scope } : {}), close: () => page.close() };
}
