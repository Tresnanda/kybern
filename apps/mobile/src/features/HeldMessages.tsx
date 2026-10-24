// Messages another thread wants to send here but could not deliver by itself (its
// permissions are broader than this thread's). They wait above the composer until you
// deliver or dismiss them; nothing is delivered silently (parity P0-5).
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import {
  heldHeadline,
  heldMessages,
  messageSenderName,
  plainLine,
  purposeLabel,
} from "../../../../packages/kybern-client/src/delegations";
import { DURATION } from "../components/liquid/motion";
import type { Thread, ThreadMessageRecord } from "../state/protocol";
import { errorText, rpc, useApp } from "../state/runtime";
import { showToast } from "../ui/Toast";
import { Button, Icon, T, Tap } from "../ui/primitives";
import { radius, space, useTheme } from "../ui/theme";

/**
 * This thread's held messages. Reloads when the thread moves (`thread_message_held`
 * and `thread_message_resolved` both advance its `last_seq`).
 */
function useHeldMessages(threadId: string | undefined, lastSeq: number) {
  const app = useApp();
  const connected = app.status === "open";
  const [held, setHeld] = useState<ThreadMessageRecord[]>([]);
  const generation = useRef(0);
  const reload = () => {
    if (!threadId || !connected) return;
    const current = ++generation.current;
    void rpc("threads.messages.list", { thread_id: threadId, states: ["held"] })
      .then((result) => {
        if (current === generation.current)
          setHeld(heldMessages(result.messages.filter((m) => m.to_thread_id === threadId)));
      })
      // An older daemon has no thread messages; nothing can be held there.
      .catch(() => {});
  };
  useEffect(() => {
    setHeld([]);
  }, [threadId]);
  useEffect(reload, [threadId, lastSeq, connected]);
  return { held, setHeld, reload };
}

export function HeldMessages({ thread, senders }: { thread?: Thread | null; senders: readonly Thread[] }) {
  const { held, setHeld, reload } = useHeldMessages(thread?.id, thread?.last_seq ?? 0);
  if (!held.length) return null;
  return (
    <View style={{ gap: space.sm }}>
      {held.map((message) => (
        <HeldRow
          key={message.id}
          message={message}
          sender={senders.find((t) => t.id === message.from_thread_id)?.title}
          onResolved={() => {
            setHeld((rows) => rows.filter((row) => row.id !== message.id));
            reload();
          }}
        />
      ))}
    </View>
  );
}

function HeldRow({
  message,
  sender,
  onResolved,
}: {
  message: ThreadMessageRecord;
  sender?: string;
  onResolved: () => void;
}) {
  const { colors } = useTheme();
  const app = useApp();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"deliver" | "dismiss" | null>(null);
  const name = messageSenderName({ from_thread_id: message.from_thread_id, from_title: sender ?? "" });
  const kind = purposeLabel(message.purpose).toLowerCase();
  async function act(action: "deliver" | "dismiss") {
    setBusy(action);
    try {
      await rpc(action === "deliver" ? "threads.messages.deliver" : "threads.messages.dismiss", { message_id: message.id });
      showToast(action === "deliver" ? `Delivered the ${kind} from ${name}` : `Dismissed the ${kind} from ${name}`);
      onResolved();
    } catch (e) {
      showToast(`Couldn't ${action} the ${kind}. ${errorText(e)}`);
      setBusy(null);
    }
  }
  return (
    <Animated.View
      entering={FadeIn.duration(DURATION.enter)}
      exiting={FadeOut.duration(DURATION.exit)}
      style={{
        borderRadius: radius.md,
        backgroundColor: colors.warningSoft,
        paddingVertical: space.sm,
        paddingHorizontal: space.md,
        gap: space.xs,
      }}
    >
      <Tap
        label={`${heldHeadline(name, message.purpose)}. ${open ? "Hide" : "Show"} message`}
        expanded={open}
        feedback="none"
        onPress={() => setOpen((value) => !value)}
        style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm, minHeight: 0 }}
      >
        <View style={{ paddingTop: 1 }}>
          <Icon name="hand.raised" size={16} color={colors.warning} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <T variant="subhead" style={{ fontWeight: "600" }} numberOfLines={2}>
            {heldHeadline(name, message.purpose)}
          </T>
          <T variant="footnote" tone="secondary" numberOfLines={open ? 12 : 2} selectable={open}>
            {open ? message.body : plainLine(message.body, 200)}
          </T>
          {open && message.held_reason ? (
            <T variant="caption" tone="muted">
              {message.held_reason}
            </T>
          ) : null}
        </View>
      </Tap>
      <View style={{ flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: space.lg }}>
        <Button
          role="plain"
          size="medium"
          label={`Dismiss ${kind} from ${name}`}
          disabled={app.status !== "open" || busy !== null}
          busy={busy === "dismiss"}
          onPress={() => void act("dismiss")}
        >
          Dismiss
        </Button>
        <Button
          role="tinted"
          size="medium"
          label={`Deliver ${kind} from ${name}`}
          disabled={app.status !== "open" || busy !== null}
          busy={busy === "deliver"}
          onPress={() => void act("deliver")}
        >
          Deliver
        </Button>
      </View>
    </Animated.View>
  );
}
