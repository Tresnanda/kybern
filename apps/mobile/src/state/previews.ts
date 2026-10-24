// Dev-server preview on the phone (parity P2-1). The computer serves a page through a
// short-lived ticket: `/preview-proxy/{ticket}/` for a server on its loopback, or
// `/preview-files/{ticket}/…` for an HTML file. The WebView only ever receives that ticket URL,
// never the daemon's credentials. Agent requests (`previews.open_requested`) live in
// `previewRequests.ts`, which the runtime attaches without importing this module.
import { httpBase } from "../../../../packages/kybern-client/src/address";
import { classifyPreviewInput, PREVIEW_REJECTED_MESSAGE } from "../../../../packages/kybern-client/src/previewTarget";
import { activeEnvironment, errorText, rpc } from "./runtime";

export type PreviewPage = {
  /** What the address bar shows: the server URL or the file path. */
  address: string;
  /** What the WebView loads. */
  uri: string;
  /** Requests under this prefix stay in the WebView; anything else opens in the browser. */
  scope: string;
};

export type PreviewOpen =
  | { kind: "page"; page: PreviewPage }
  | { kind: "browser"; url: string }
  | { kind: "permission"; folder: string; grantable: boolean }
  | { kind: "error"; message: string };

/** Classify what the user typed (or an agent asked for) and get a page the WebView may load. */
export async function openPreview(threadId: string, input: string, allowFolder = false): Promise<PreviewOpen> {
  const env = activeEnvironment();
  if (!env) return { kind: "error", message: "Connect to your computer, then try again." };
  const base = httpBase(env.url);
  const target = classifyPreviewInput(input);
  switch (target.kind) {
    case "empty":
      return { kind: "error", message: "Type a port, an address or a file path." };
    case "rejected":
      return { kind: "error", message: PREVIEW_REJECTED_MESSAGE };
    case "search":
      return { kind: "error", message: `“${target.query}” isn't an address. Type a port like 5173, or a file path.` };
    case "external":
      return { kind: "browser", url: target.url };
    case "server":
      // A server on the computer's network is reachable from the phone as it is.
      if (target.scope === "private") return { kind: "page", page: { address: target.url, uri: target.url, scope: new URL(target.url).origin } };
      break;
    case "file":
      break;
  }
  try {
    const result = await rpc("previews.open", {
      thread_id: threadId,
      target: target.kind === "server" ? target.url : target.path,
      proxy: true,
      ...(allowFolder ? { allow_folder: true } : {}),
    });
    if (result.needs_permission)
      return { kind: "permission", folder: result.needs_permission.folder, grantable: result.needs_permission.grantable };
    if (result.target.kind === "external") return { kind: "browser", url: result.target.url };
    if (!result.path || !result.ticket) return { kind: "error", message: "Your computer could not serve this page. Update Kybern there, then try again." };
    const scope = `${base}${result.path.slice(0, result.path.indexOf(result.ticket) + result.ticket.length)}/`;
    const address = result.target.kind === "server" ? result.target.url : result.target.path;
    return { kind: "page", page: { address, uri: `${base}${result.path}`, scope } };
  } catch (e) {
    return { kind: "error", message: errorText(e) };
  }
}

/** Give the ticket back when the page closes; the daemon also expires it on its own. */
export function closePreview(page: PreviewPage | null) {
  const ticket = page?.scope.match(/\/preview-(?:proxy|files)\/([^/]+)\//)?.[1];
  if (ticket) void rpc("previews.close", { ticket }).catch(() => {});
}
