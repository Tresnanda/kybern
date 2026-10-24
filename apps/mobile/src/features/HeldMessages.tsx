// Messages another thread wants to send here but could not deliver by itself (its
// permissions are broader than this thread's). They wait on the bottom bar until you
// deliver or dismiss them; nothing is delivered silently (parity P0-5).
//
// On the bar they sit on the bar's own material like the status strip, without a box:
// one message is "Question from <sender>" with a two-line preview and Dismiss / Deliver;
// two or more fold into one "2 held messages" row. The whole text, the reason it was
// held and the actions for every message live in the /held sheet.
import { router } from "expo-router";
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
import { count, nameList } from "../state/format";
import type { Thread, ThreadMessageRecord } from "../state/protocol";
import { errorText, rpc, useApp } from "../state/runtime";
import { InsetGroup, SectionFooter, SectionHeader } from "../ui/List";
import { showToast } from "../ui/Toast";
import { Button, Icon, T, Tap } from "../ui/primitives";
import { radius, space, useTheme } from "../ui/theme";

/**
 * A thread's held messages. Reloads when the thread moves (`thread_message_held`
 * and `thread_message_resolved` both advance its `last_seq`).
 */
export function useHeldMessages(threadId: string | undefined, lastSeq: number) {
  const app = useApp();
  const connected = app.status === "open";
  const [held, setHeld] = useState<ThreadMessageRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const generation = useRef(0);
  const reload = () => {
    if (!threadId || !connected) return;
    const current = ++generation.current;
    void rpc("threads.messages.list", { thread_id: threadId, states: ["held"] })
      .then((result) => {
        if (current !== generation.current) return;
        setHeld(heldMessages(result.messages.filter((m) => m.to_thread_id === threadId)));
        setLoaded(true);
      })
      // An older daemon has no thread messages; nothing can be held there.
      .catch(() => {});
  };
  useEffect(() => {
    setHeld([]);
    setLoaded(false);
  }, [threadId]);
  useEffect(reload, [threadId, lastSeq, connected]);
  const resolved = (id: string) => {
    setHeld((rows) => rows.filter((row) => row.id !== id));
    reload();
  };
  return { held, loaded, resolved };
}

/** "Review sign-in", or "Kybern" when Kybern itself sent it. */
function useSenderName(senders: readonly Thread[] = []) {
  const app = useApp();
  return (message: ThreadMessageRecord) => {
    const id = message.from_thread_id;
    const title = id ? (senders.find((t) => t.id === id) ?? app.threads.find((t) => t.id === id))?.title : undefined;
    return messageSenderName({ from_thread_id: id, from_title: title ?? "" });
  };
}

/** Deliver or dismiss one held message, with a toast either way. */
function useResolve(message: ThreadMessageRecord, name: string, onResolved: () => void) {
  const [busy, setBusy] = useState<"deliver" | "dismiss" | null>(null);
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
  return { busy, act, kind };
}

const openThread = (id: string) => router.push({ pathname: "/thread/[id]", params: { id } });
const openSheet = (threadId: string) => router.push({ pathname: "/held", params: { threadId } });

/** The bottom bar's held messages: nothing, one message, or one row for several. */
export function HeldMessages({ thread, senders }: { thread?: Thread | null; senders: readonly Thread[] }) {
  const { held, resolved } = useHeldMessages(thread?.id, thread?.last_seq ?? 0);
  const senderName = useSenderName(senders);
  if (!thread || !held.length) return null;
  return held.length === 1 ? (
    <HeldBarMessage
      key={held[0]!.id}
      threadId={thread.id}
      message={held[0]!}
      name={senderName(held[0]!)}
      onResolved={() => resolved(held[0]!.id)}
    />
  ) : (
    <HeldBarSummary threadId={thread.id} names={held.map(senderName)} />
  );
}

function HeldBarMessage({
  threadId,
  message,
  name,
  onResolved,
}: {
  threadId: string;
  message: ThreadMessageRecord;
  name: string;
  onResolved: () => void;
}) {
  const { colors } = useTheme();
  const app = useApp();
  const { busy, act, kind } = useResolve(message, name, onResolved);
  const from = message.from_thread_id;
  return (
    <Animated.View
      entering={FadeIn.duration(DURATION.enter)}
      exiting={FadeOut.duration(DURATION.exit)}
      accessibilityLabel={`${heldHeadline(name, message.purpose)}, waiting for you`}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 36 }}>
        <Icon name="text.bubble" size={15} color={colors.secondary} />
        <T variant="footnote" tone="secondary" numberOfLines={1} style={{ flex: 1 }}>
          {`${purposeLabel(message.purpose)} from `}
          <T
            variant="footnote"
            tone={from ? "accent" : "secondary"}
            style={{ fontWeight: "600" }}
            accessibilityRole={from ? "link" : undefined}
            onPress={from ? () => openThread(from) : undefined}
          >
            {name}
          </T>
        </T>
        <Button
          role="plain"
          size="medium"
          label={`Dismiss the ${kind} from ${name}`}
          disabled={app.status !== "open" || busy !== null}
          busy={busy === "dismiss"}
          onPress={() => void act("dismiss")}
        >
          Dismiss
        </Button>
        <Button
          role="prominent"
          size="medium"
          label={`Deliver the ${kind} from ${name}`}
          disabled={app.status !== "open" || busy !== null}
          busy={busy === "deliver"}
          onPress={() => void act("deliver")}
        >
          Deliver
        </Button>
      </View>
      {/* The preview reads the whole message in the sheet; it lines up with the headline text. */}
      <Tap
        label={`Read the whole ${kind}`}
        feedback="none"
        onPress={() => openSheet(threadId)}
        style={{ flexDirection: "row", minHeight: 0, paddingStart: 15 + space.sm, paddingBottom: space.xs }}
      >
        <T variant="subhead" numberOfLines={2} style={{ flex: 1 }}>
          {plainLine(message.body, 240)}
        </T>
      </Tap>
    </Animated.View>
  );
}

function HeldBarSummary({ threadId, names }: { threadId: string; names: string[] }) {
  const { colors } = useTheme();
  const title = count(names.length, "held message");
  const from = `From ${nameList(names)}`;
  return (
    <Animated.View entering={FadeIn.duration(DURATION.enter)} exiting={FadeOut.duration(DURATION.exit)}>
      <Tap
        label={`${title}. ${from}. Review`}
        feedback="highlight"
        onPress={() => openSheet(threadId)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: space.sm,
          minHeight: 44,
          marginHorizontal: -space.sm,
          paddingHorizontal: space.sm,
          borderRadius: radius.md,
        }}
      >
        <Icon name="text.bubble" size={15} color={colors.secondary} />
        <View style={{ flex: 1 }}>
          <T variant="subhead" style={{ fontWeight: "600", fontVariant: ["tabular-nums"] }} numberOfLines={1}>
            {title}
          </T>
          <T variant="footnote" tone="secondary" numberOfLines={1}>
            {from}
          </T>
        </View>
        <T variant="label" tone="accent">
          Review
        </T>
        <Icon name="chevron.right" size={12} color={colors.muted} />
      </Tap>
    </Animated.View>
  );
}

/** The /held sheet: every held message in full, each with its sender, reason and actions. */
export function HeldMessageList({ thread, onEmpty }: { thread: Thread | null | undefined; onEmpty: () => void }) {
  const { held, loaded, resolved } = useHeldMessages(thread?.id, thread?.last_seq ?? 0);
  const senderName = useSenderName();
  // Everything was delivered or dismissed (here or elsewhere): nothing left to show.
  useEffect(() => {
    if (loaded && !held.length) onEmpty();
  }, [loaded, held.length]);
  return (
    <View>
      {held.map((message, index) => (
        <HeldSheetMessage
          key={message.id}
          first={index === 0}
          message={message}
          name={senderName(message)}
          onResolved={() => resolved(message.id)}
        />
      ))}
      {held.length > 0 && (
        <SectionFooter inset>
          These wait because the sender may do more than this thread allows. Deliver sends one the way its sender asked.
        </SectionFooter>
      )}
    </View>
  );
}

function HeldSheetMessage({
  message,
  name,
  first,
  onResolved,
}: {
  message: ThreadMessageRecord;
  name: string;
  first: boolean;
  onResolved: () => void;
}) {
  const app = useApp();
  const { busy, act, kind } = useResolve(message, name, onResolved);
  const from = message.from_thread_id;
  return (
    <View style={{ marginBottom: space.xl }}>
      <SectionHeader
        title={`${purposeLabel(message.purpose)} from ${name}`}
        inset
        first={first}
        action={
          from
            ? {
                title: "Open",
                label: `Open ${name}`,
                onPress: () => {
                  router.back();
                  openThread(from);
                },
              }
            : undefined
        }
      />
      <InsetGroup>
        <View style={{ padding: space.lg, gap: space.md }}>
          <T variant="prose" selectable>
            {message.body}
          </T>
          {message.held_reason ? (
            <T variant="footnote" tone="muted">
              {message.held_reason}
            </T>
          ) : null}
          <View style={{ flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: space.lg }}>
            <Button
              role="plain"
              size="medium"
              label={`Dismiss the ${kind} from ${name}`}
              disabled={app.status !== "open" || busy !== null}
              busy={busy === "dismiss"}
              onPress={() => void act("dismiss")}
            >
              Dismiss
            </Button>
            <Button
              role="prominent"
              size="medium"
              label={`Deliver the ${kind} from ${name}`}
              disabled={app.status !== "open" || busy !== null}
              busy={busy === "deliver"}
              onPress={() => void act("deliver")}
            >
              Deliver
            </Button>
          </View>
        </View>
      </InsetGroup>
    </View>
  );
}
