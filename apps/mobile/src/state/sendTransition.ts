import type { UserMessage } from "./protocol";
import type { TurnRow } from "./turnRows";

export type SendReceipt = { threadId: string; messageId?: string };
export type SendRect = { x: number; y: number; width: number; height: number };
export type SendSource = { rect: SendRect; uri?: string };
export type SendFlight = {
  id: number;
  receipt: SendReceipt;
  message: UserMessage;
  sources: Record<string, SendSource>;
};

export const DRAFT_SEND_THREAD = "pending-new-thread";
export type OutgoingSend = {
  id: number;
  key: string;
  threadId: string;
  sourceThreadId: string;
  afterSeq: number;
  at: string;
  message: UserMessage;
  sources: Record<string, SendSource>;
  receipt?: SendReceipt;
  received?: boolean;
};

export function outgoingBlock(send: OutgoingSend) {
  return {
    kind: "user" as const,
    id: send.key,
    turnId: send.key,
    seq: send.afterSeq + 1,
    at: send.at,
    message: send.message,
  };
}

function samePendingMessage(sent: UserMessage, received: UserMessage) {
  return (
    sent.parts.length === received.parts.length &&
    sent.parts.every((part, index) => {
      const other = received.parts[index]!;
      if (
        part.type === "attachment" &&
        part.media_type.startsWith("image/") &&
        other.type === "image"
      )
        return part.media_type === other.media_type;
      return JSON.stringify(part) === JSON.stringify(other);
    })
  );
}

/** Keep a local row through event/receipt ordering, without changing history.
 * A provisional event match only deduplicates presentation; the receipt alone
 * confirms delivery. If another client sends identical content, its row returns
 * as soon as our authoritative message id is known.
 */
export function createOutgoingProjection() {
  const aliases = new Map<string, string>();
  const aliasedRows = new WeakMap<TurnRow, TurnRow>();
  return (
    rows: TurnRow[],
    outgoing: OutgoingSend | null,
  ): { rows: TurnRow[]; received: boolean } => {
    const candidate = outgoing
      ? rows.find(
          (row) =>
            row.kind === "block" &&
            row.block.kind === "user" &&
            (outgoing.receipt?.messageId
              ? row.block.id === outgoing.receipt.messageId
              : row.block.seq > outgoing.afterSeq &&
                samePendingMessage(outgoing.message, row.block.message)),
        )
      : undefined;
    if (outgoing?.receipt && candidate?.kind === "block")
      aliases.set(candidate.block.id, outgoing.key);
    // Only identities for mounted/history rows need to survive this projection.
    if (aliases.size > 128) {
      const present = new Set(
        rows.flatMap((row) => (row.kind === "block" ? [row.block.id] : [])),
      );
      for (const key of aliases.keys())
        if (!present.has(key)) aliases.delete(key);
    }
    const projected = rows.map((row) => {
      if (outgoing && row === candidate && row.kind === "block")
        return {
          ...row,
          key: outgoing.key,
          block: {
            ...outgoingBlock(outgoing),
            seq: row.block.seq,
            turnId: row.block.turnId,
          },
        };
      const alias =
        row.kind === "block" ? aliases.get(row.block.id) : undefined;
      if (!alias || alias === row.key) return row;
      const cached = aliasedRows.get(row);
      if (cached?.key === alias) return cached;
      const stable = { ...row, key: alias };
      aliasedRows.set(row, stable);
      return stable;
    });
    if (outgoing && !candidate)
      projected.push({
        kind: "block",
        key: outgoing.key,
        block: outgoingBlock(outgoing),
        nested: false,
      });
    return { rows: projected, received: !!outgoing?.receipt && !!candidate };
  };
}

export function sendPartKey(
  part: UserMessage["parts"][number],
  index: number,
): string {
  if (part.type === "text") return "text";
  if (part.type === "attachment") return `asset:${part.asset_id}`;
  return `part:${index}`;
}

// Receipt identity prevents an old identical prompt from taking the animation.
// New-thread creation returns only the new thread id; message equality is safe
// there because that conversation did not exist before this send.
export function matchesSend(
  flight: SendFlight,
  threadId: string,
  messageId: string,
  message: UserMessage,
): boolean {
  return (
    flight.receipt.threadId === threadId &&
    (flight.receipt.messageId
      ? flight.receipt.messageId === messageId
      : flight.message.parts.length === message.parts.length &&
        flight.message.parts.every((sent, index) => {
          const received = message.parts[index]!;
          // The daemon resolves uploaded images in place before persisting the
          // initial user message. This exception is scoped to a newly created
          // thread, never to matching arbitrary history by image type.
          if (
            sent.type === "attachment" &&
            sent.media_type.startsWith("image/") &&
            received.type === "image"
          )
            return sent.media_type === received.media_type;
          const record = received as unknown as Record<string, unknown>;
          return Object.entries(sent).every(
            ([key, value]) => record[key] === value,
          );
        }))
  );
}

export function usableSendRect(rect: SendRect): boolean {
  return (
    Object.values(rect).every(Number.isFinite) &&
    rect.width > 0 &&
    rect.height > 0
  );
}
