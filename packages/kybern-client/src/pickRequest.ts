// `kybern_request_pick` cards, as the clients show them: reading the card's input and the words of each kind. The picking itself
// (the page overlay, the tree, the drop zone) is each client's own.
import { PICK_REQUEST_TOOL, type ApprovalDecision, type ApprovalRequest, type PickKind, type PickRequestInput } from "./types.ts";

const KINDS: readonly PickKind[] = ["preview_element", "visual_element", "file", "folder", "image", "window"];

/** The card's input when the approval is a pick request; null for any other approval. */
export function pickRequestInput(approval: Pick<ApprovalRequest, "tool_name" | "input">): PickRequestInput | null {
  if (approval.tool_name !== PICK_REQUEST_TOOL) return null;
  const input = approval.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const kind = KINDS.find((candidate) => candidate === record.kind);
  if (!kind) return null;
  return { kind, prompt: typeof record.prompt === "string" ? record.prompt : "" };
}

export const isElementPick = (kind: PickKind): boolean => kind === "preview_element" || kind === "visual_element";

/** The card's title for each kind; `agent` is the harness's short name ("Claude", "Codex"). */
export function pickTitle(kind: PickKind, agent: string): string {
  switch (kind) {
    case "preview_element":
    case "visual_element": return `Point to the element ${agent} means`;
    case "file": return `Pick the file ${agent} should use`;
    case "folder": return `Pick the folder ${agent} should use`;
    case "image": return `Drop the image ${agent} should look at`;
    case "window": return "Choose the window to capture";
  }
}

/** The bar the page shows while picking. */
export const pickOverlayLabel = (agent: string) => `Click the element ${agent} means`;

/** The one quiet line a pick request leaves in the transcript. */
export function pickRecordText(input: PickRequestInput, decision: ApprovalDecision | null, live = true): string {
  const what: Record<PickKind, string> = {
    preview_element: "an element in the Preview",
    visual_element: "an element in a visual",
    file: "a file",
    folder: "a folder",
    image: "an image",
    window: "a window",
  };
  if (!decision) return live ? `Waiting for you to point to ${what[input.kind]}` : `Asked you to point to ${what[input.kind]}`;
  return decision.decision === "submit" ? `You pointed to ${what[input.kind]}` : `Declined to point to ${what[input.kind]}`;
}
