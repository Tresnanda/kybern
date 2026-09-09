import type { UserMessage } from "./protocol";

export type SendReceipt = { threadId: string; messageId?: string };
export type SendRect = { x: number; y: number; width: number; height: number };
export type SendSource = { rect: SendRect; uri?: string };
export type SendFlight = {
  id: number;
  receipt: SendReceipt;
  message: UserMessage;
  sources: Record<string, SendSource>;
};

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
