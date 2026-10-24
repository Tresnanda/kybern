// Messages another thread wants to send here but could not deliver by itself (its
// permissions are broader than this thread's). They wait until you deliver or dismiss
// them; nothing is delivered silently (parity P0-5).
//
//   HeldBubbles   the transcript's end: a message as an incoming bubble, with
//                 "● Review sign-in · Question · waiting for you" above it and Deliver /
//                 Dismiss under it. Several stack like a notification group and fan out
//                 on Show all. Delivering lifts the bubble away; the message then
//                 arrives in the thread like any other.
//   HeldSection   "Waiting for you" at the top of the Agents list (sheet, /tasks, iPad
//                 inspector), the same messages as compact rows.
//   WaitingBadge  the count on the bottom bar's Agents capsule.
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, View, type TextLayoutEvent } from "react-native";
import Animated, {
  FadeIn,
  FadeOut,
  LinearTransition,
  ReduceMotion,
  useReducedMotion,
  withDelay,
  withSpring,
  withTiming,
  type EntryExitAnimationFunction,
} from "react-native-reanimated";
import {
  heldMessages,
  messageSenderName,
  plainLine,
  purposeLabel,
} from "../../../../packages/kybern-client/src/delegations";
import { DURATION, EASE_OUT, MASS, SIZE } from "../components/liquid/motion";
import type { Thread, ThreadMessageRecord } from "../state/protocol";
import { count } from "../state/format";
import { errorText, rpc, useApp, useThreadValue } from "../state/runtime";
import type { ThreadState } from "../state/transcript";
import { MenuButton } from "../ui/ActionMenu";
import { confirm } from "../ui/Alert";
import { InsetGroup, ListSeparator, SectionHeader } from "../ui/List";
import { haptics } from "../ui/haptics";
import { showToast } from "../ui/Toast";
import { Button, Icon, T, Tap } from "../ui/primitives";
import { radius, space, useTheme } from "../ui/theme";

/**
 * A thread's held messages, oldest first. Reloads when the thread moves
 * (`thread_message_held` and `thread_message_resolved` both advance its `last_seq`).
 */
export function useHeldMessages(threadId: string | undefined, lastSeq: number) {
  const app = useApp();
  const connected = app.status === "open";
  const [held, setHeld] = useState<ThreadMessageRecord[]>([]);
  const generation = useRef(0);
  const reload = () => {
    if (!threadId || !connected) return;
    const current = ++generation.current;
    void rpc("threads.messages.list", { thread_id: threadId, states: ["held"] })
      .then((result) => {
        if (current !== generation.current) return;
        setHeld(heldMessages(result.messages.filter((m) => m.to_thread_id === threadId)));
      })
      // An older daemon has no thread messages; nothing can be held there.
      .catch(() => {});
  };
  useEffect(() => setHeld([]), [threadId]);
  useEffect(reload, [threadId, lastSeq, connected]);
  const resolved = (id: string) => {
    setHeld((rows) => rows.filter((row) => row.id !== id));
    reload();
  };
  return { held, resolved };
}

const lastSeqOf = (snapshot: ThreadState) => snapshot.thread?.last_seq ?? 0;

/** `useHeldMessages` for a thread known only by id (the Agents list). */
export function useThreadHeld(threadId: string) {
  const app = useApp();
  const loaded = useThreadValue(threadId, lastSeqOf);
  const listed = app.threads.find((t) => t.id === threadId)?.last_seq;
  return useHeldMessages(threadId, Math.max(listed ?? 0, loaded));
}

/** "Review sign-in", or "Kybern" when Kybern itself sent it. */
export function useSenderName(senders: readonly Thread[] = []) {
  const app = useApp();
  return (message: ThreadMessageRecord) => {
    const id = message.from_thread_id;
    const title = id ? (senders.find((t) => t.id === id) ?? app.threads.find((t) => t.id === id))?.title : undefined;
    return messageSenderName({ from_thread_id: id, from_title: title ?? "" });
  };
}

type Resolution = "deliver" | "dismiss";

/**
 * Deliver or dismiss one held message. Success shows as the message leaving (and,
 * once delivered, arriving in the thread); only a failure gets a toast.
 */
function useResolve(message: ThreadMessageRecord, name: string, onResolved: () => void) {
  const [busy, setBusy] = useState<Resolution | null>(null);
  const [leaving, setLeaving] = useState<Resolution | null>(null);
  const kind = purposeLabel(message.purpose).toLowerCase();
  async function act(action: Resolution) {
    setBusy(action);
    try {
      await rpc(action === "deliver" ? "threads.messages.deliver" : "threads.messages.dismiss", { message_id: message.id });
      if (action === "deliver") haptics.success();
      else haptics.commit();
      // Commit the exit animation for this action before the row unmounts.
      setLeaving(action);
      requestAnimationFrame(onResolved);
    } catch (e) {
      haptics.error();
      showToast(`Couldn't ${action} the ${kind}. ${errorText(e)}`);
      setBusy(null);
    }
  }
  return { busy, leaving, act, kind };
}

const openThread = (id: string) => router.push({ pathname: "/thread/[id]", params: { id } });

// Motion. Arriving rises a little into place; delivering lifts the bubble away with
// mass (position on MASS, opacity under 250 ms); dismissing sinks and fades while the
// bubbles after it close the gap. Text never scales. Reduce Motion: fades only.
const rise: EntryExitAnimationFunction = () => {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ translateY: 10 }] },
    animations: {
      opacity: withTiming(1, { duration: DURATION.enter, easing: EASE_OUT }),
      transform: [{ translateY: withSpring(0, MASS) }],
    },
  };
};
const lift: EntryExitAnimationFunction = () => {
  "worklet";
  return {
    initialValues: { opacity: 1, transform: [{ translateY: 0 }] },
    animations: {
      opacity: withTiming(0, { duration: 240, easing: EASE_OUT }),
      transform: [{ translateY: withSpring(-36, MASS) }],
    },
  };
};
const sink: EntryExitAnimationFunction = () => {
  "worklet";
  return {
    initialValues: { opacity: 1, transform: [{ translateY: 0 }] },
    animations: {
      opacity: withTiming(0, { duration: DURATION.exit, easing: EASE_OUT }),
      transform: [{ translateY: withTiming(6, { duration: DURATION.exit, easing: EASE_OUT }) }],
    },
  };
};
const closeGap = LinearTransition.springify()
  .stiffness(SIZE.stiffness)
  .damping(SIZE.damping)
  .reduceMotion(ReduceMotion.System);

function useHeldMotion(leaving: Resolution | null) {
  const reduced = useReducedMotion();
  return {
    entering: reduced ? FadeIn.duration(DURATION.enter) : rise,
    exiting: reduced ? FadeOut.duration(DURATION.exit) : leaving === "deliver" ? lift : sink,
    layout: reduced ? undefined : closeGap,
  };
}

/** A blue dot: something here waits for you. */
function WaitingDot() {
  const { colors } = useTheme();
  return <View accessible={false} style={{ width: 7, height: 7, borderRadius: radius.full, backgroundColor: colors.accent }} />;
}

/** "● Review sign-in · Question · waiting for you". The sender opens its thread. */
function HeldMeta({
  message,
  name,
  waiting,
  beforeOpen,
}: {
  message: ThreadMessageRecord;
  name: string;
  waiting: boolean;
  beforeOpen?: () => void;
}) {
  const from = message.from_thread_id;
  const rest = ` · ${purposeLabel(message.purpose)}${waiting ? " · waiting for you" : ""}`;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 20 }}>
      <WaitingDot />
      <View style={{ flexDirection: "row", alignItems: "baseline", flexShrink: 1 }}>
        <T
          variant="footnote"
          numberOfLines={1}
          accessibilityRole={from ? "link" : undefined}
          accessibilityLabel={from ? `Open ${name}` : name}
          suppressHighlighting
          onPress={
            from
              ? () => {
                  beforeOpen?.();
                  openThread(from);
                }
              : undefined
          }
          style={{ fontWeight: "600", flexShrink: 1 }}
        >
          {name}
        </T>
        <T variant="footnote" tone="secondary" numberOfLines={1} style={{ flexShrink: 0 }} accessibilityLabel={rest.slice(3)}>
          {rest}
        </T>
      </View>
    </View>
  );
}

function HeldActions({
  name,
  kind,
  busy,
  onAct,
}: {
  name: string;
  kind: string;
  busy: Resolution | null;
  onAct: (action: Resolution) => void;
}) {
  const app = useApp();
  const disabled = app.status !== "open" || busy !== null;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.lg }}>
      <Button
        role="tinted"
        size="small"
        label={`Deliver the ${kind} from ${name}`}
        disabled={disabled}
        busy={busy === "deliver"}
        onPress={() => onAct("deliver")}
      >
        Deliver
      </Button>
      <Button
        role="plain"
        size="small"
        label={`Dismiss the ${kind} from ${name}`}
        disabled={disabled}
        busy={busy === "dismiss"}
        onPress={() => onAct("dismiss")}
      >
        Dismiss
      </Button>
    </View>
  );
}

const BUBBLE_LINES = 6;
const STACK_LINES = 4;
/** Each card edge behind a stack sits this much lower (and 4 % narrower). */
const PEEK = 6;

// Fanning out: each bubble drops out of the stack after the one before it, its mass
// on SIZE's spring so it settles with a slight recoil. Text never scales.
const fan = (order: number): EntryExitAnimationFunction => () => {
  "worklet";
  const delay = Math.min(order, 4) * 45;
  return {
    initialValues: { opacity: 0, transform: [{ translateY: -14 - Math.min(order, 2) * PEEK }] },
    animations: {
      opacity: withDelay(delay, withTiming(1, { duration: DURATION.enter, easing: EASE_OUT })),
      transform: [{ translateY: withDelay(delay, withSpring(0, SIZE)) }],
    },
  };
};

/**
 * The transcript's held messages. One is an incoming bubble. Several stack like a
 * notification group: the newest in front with one or two card edges behind it,
 * under "2 messages waiting · Show all · …". Show all fans them out, oldest first.
 */
export function HeldBubbles({
  held,
  senderName,
  onResolved,
}: {
  held: readonly ThreadMessageRecord[];
  senderName: (message: ThreadMessageRecord) => string;
  onResolved: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const several = held.length > 1;
  useEffect(() => {
    if (!several) setOpen(false);
  }, [several]);
  if (!held.length) return null;
  const newest = held[held.length - 1]!;
  return (
    <View style={{ gap: space.md, paddingTop: space.sm }}>
      {several && (
        <HeldStackHeader held={held} open={open} onToggle={() => setOpen((value) => !value)} onResolved={onResolved} />
      )}
      {several && open ? (
        <View style={{ gap: space.xl }}>
          {held.map((message, order) => (
            <HeldBubble
              key={message.id}
              message={message}
              name={senderName(message)}
              order={order}
              onResolved={() => onResolved(message.id)}
            />
          ))}
        </View>
      ) : (
        <HeldBubble
          key={`${several ? "stack" : "one"}:${newest.id}`}
          message={newest}
          name={senderName(newest)}
          peeks={Math.min(2, held.length - 1)}
          onOpenStack={several ? () => setOpen(true) : undefined}
          onResolved={() => onResolved(newest.id)}
        />
      )}
    </View>
  );
}

/** "2 messages waiting", Show all / Show less, and a menu with Deliver all and Dismiss all. */
function HeldStackHeader({
  held,
  open,
  onToggle,
  onResolved,
}: {
  held: readonly ThreadMessageRecord[];
  open: boolean;
  onToggle: () => void;
  onResolved: (id: string) => void;
}) {
  const app = useApp();
  const { colors } = useTheme();
  const n = held.length;
  async function resolveAll(action: Resolution) {
    for (const message of [...held]) {
      try {
        await rpc(action === "deliver" ? "threads.messages.deliver" : "threads.messages.dismiss", { message_id: message.id });
        onResolved(message.id);
      } catch (e) {
        haptics.error();
        showToast(`Couldn't ${action} every message. ${errorText(e)}`);
        return;
      }
    }
    if (action === "deliver") haptics.success();
    else haptics.commit();
  }
  const offline = app.status !== "open";
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, minHeight: 32 }}>
      <T variant="footnote" tone="secondary" numberOfLines={1} style={{ flex: 1, fontWeight: "600", fontVariant: ["tabular-nums"] }}>
        {`${count(n, "message")} waiting`}
      </T>
      <Tap
        label={open ? "Show less" : `Show all ${n} messages`}
        expanded={open}
        feedback="none"
        onPress={onToggle}
        hitSlop={{ top: 6, bottom: 6 }}
        style={{ minHeight: 32, paddingHorizontal: space.xs, flexDirection: "row", alignItems: "center" }}
      >
        <T variant="footnote" tone="accent" style={{ fontWeight: "500" }}>
          {open ? "Show less" : "Show all"}
        </T>
      </Tap>
      <MenuButton
        label="Waiting messages"
        title={`${count(n, "message")} waiting`}
        radius={radius.full}
        disabled={offline}
        items={[
          { title: "Deliver all", icon: "paperplane", onPress: () => void resolveAll("deliver") },
          {
            title: "Dismiss all",
            icon: "xmark.circle",
            destructive: true,
            onPress: () =>
              confirm({
                title: `Dismiss ${count(n, "message")}?`,
                message: "They won't reach this thread's agent.",
                confirm: "Dismiss all",
                onConfirm: () => void resolveAll("dismiss"),
              }),
          },
        ]}
      >
        <View style={{ width: 32, height: 32, alignItems: "center", justifyContent: "center" }}>
          <Icon name="ellipsis" size={18} color={colors.secondary} />
        </View>
      </MenuButton>
    </View>
  );
}

function HeldBubble({
  message,
  name,
  onResolved,
  peeks = 0,
  onOpenStack,
  order,
}: {
  message: ThreadMessageRecord;
  name: string;
  onResolved: () => void;
  /** Card edges behind a collapsed stack (0–2). */
  peeks?: number;
  /** Set on a collapsed stack: tapping the bubble fans the stack out. */
  onOpenStack?: () => void;
  /** Position in a fanned-out stack, for the stagger. */
  order?: number;
}) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const { busy, leaving, act, kind } = useResolve(message, name, onResolved);
  const motion = useHeldMotion(leaving);
  const [expanded, setExpanded] = useState(false);
  const [long, setLong] = useState(false);
  const body = message.body.trim();
  const stacked = !!onOpenStack;
  // A hidden, unclamped copy counts the lines, so "Show more" appears only when text is cut.
  const measure = (e: TextLayoutEvent) => setLong(e.nativeEvent.lines.length > BUBBLE_LINES);
  const edge = { position: "absolute", borderRadius: radius.lg, borderCurve: "continuous", backgroundColor: colors.raised, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line } as const;
  const bubble = (
    <View style={{ alignSelf: "flex-start", maxWidth: "88%", marginBottom: peeks * PEEK }}>
      {peeks >= 2 && <View style={[edge, { top: 2 * PEEK, bottom: -2 * PEEK, start: "4%", end: "4%", opacity: 0.55 }]} />}
      {peeks >= 1 && <View style={[edge, { top: PEEK, bottom: -PEEK, start: "2%", end: "2%" }]} />}
      <View
        style={{
          borderRadius: radius.lg,
          borderBottomStartRadius: radius.xs,
          borderCurve: "continuous",
          paddingHorizontal: 14,
          paddingVertical: 10,
          backgroundColor: colors.card,
          gap: space.xs,
        }}
      >
        {stacked ? (
          <T numberOfLines={STACK_LINES}>{body}</T>
        ) : (
          <View>
            <T selectable numberOfLines={expanded ? undefined : BUBBLE_LINES}>
              {body}
            </T>
            <T
              aria-hidden
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              pointerEvents="none"
              onTextLayout={measure}
              style={{ position: "absolute", top: 0, start: 0, end: 0, opacity: 0 }}
            >
              {body}
            </T>
          </View>
        )}
        {!stacked && long && (
          <Tap
            label={expanded ? "Show less" : `Show the whole ${kind}`}
            expanded={expanded}
            onPress={() => setExpanded((value) => !value)}
            hitSlop={{ top: 6, bottom: 6 }}
            style={{ alignSelf: "flex-start", minHeight: 28 }}
          >
            <T variant="footnote" tone="accent" style={{ fontWeight: "500" }}>
              {expanded ? "Show less" : "Show more"}
            </T>
          </Tap>
        )}
      </View>
    </View>
  );
  return (
    <Animated.View
      entering={order != null && !reduced ? fan(order) : motion.entering}
      exiting={motion.exiting}
      layout={motion.layout}
      style={{ gap: space.sm }}
    >
      <HeldMeta message={message} name={name} waiting />
      {stacked ? (
        <Tap label="Show all waiting messages" feedback="none" onPress={onOpenStack} style={{ flexDirection: "row", minHeight: 0 }}>
          {bubble}
        </Tap>
      ) : (
        bubble
      )}
      <HeldActions name={name} kind={kind} busy={busy} onAct={(action) => void act(action)} />
    </Animated.View>
  );
}

/**
 * "Waiting for you" over the Agents list: every held message as a compact row
 * (sender, purpose, two-line preview that expands, Deliver and Dismiss).
 * `beforeOpen` closes a sheet before the sender's thread is pushed.
 */
export function HeldSection({
  held,
  resolved,
  senders,
  beforeOpen,
}: ReturnType<typeof useHeldMessages> & {
  senders?: readonly Thread[];
  beforeOpen?: () => void;
}) {
  const senderName = useSenderName(senders);
  if (!held.length) return null;
  return (
    <Animated.View entering={FadeIn.duration(DURATION.enter)} exiting={FadeOut.duration(DURATION.exit)}>
      <SectionHeader title="Waiting for you" count={held.length} inset />
      <InsetGroup>
        {held.map((message, index) => (
          <HeldRow
            key={message.id}
            message={message}
            name={senderName(message)}
            separator={index > 0}
            beforeOpen={beforeOpen}
            onResolved={() => resolved(message.id)}
          />
        ))}
      </InsetGroup>
    </Animated.View>
  );
}

function HeldRow({
  message,
  name,
  separator,
  beforeOpen,
  onResolved,
}: {
  message: ThreadMessageRecord;
  name: string;
  separator: boolean;
  beforeOpen?: () => void;
  onResolved: () => void;
}) {
  const { busy, leaving, act, kind } = useResolve(message, name, onResolved);
  const motion = useHeldMotion(leaving);
  const [expanded, setExpanded] = useState(false);
  return (
    <Animated.View entering={motion.entering} exiting={motion.exiting} layout={motion.layout}>
      {separator && <ListSeparator />}
      <View style={{ paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.sm }}>
        <HeldMeta message={message} name={name} waiting={false} beforeOpen={beforeOpen} />
        <Tap
          label={expanded ? `Show less of the ${kind}` : `Show the whole ${kind}`}
          expanded={expanded}
          feedback="none"
          onPress={() => setExpanded((value) => !value)}
          style={{ flexDirection: "row", minHeight: 0 }}
        >
          <T variant="subhead" numberOfLines={expanded ? undefined : 2} style={{ flex: 1 }}>
            {expanded ? message.body.trim() : plainLine(message.body, 240)}
          </T>
        </Tap>
        <HeldActions name={name} kind={kind} busy={busy} onAct={(action) => void act(action)} />
      </View>
    </Animated.View>
  );
}

// The badge: its fill springs in from 0.5 with SIZE's slight recoil while the number
// only fades (text never scales). Reduce Motion: the whole badge fades.
const badgeIn: EntryExitAnimationFunction = () => {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ scale: 0.5 }] },
    animations: {
      opacity: withTiming(1, { duration: DURATION.state, easing: EASE_OUT }),
      transform: [{ scale: withSpring(1, SIZE) }],
    },
  };
};
const badgeOut: EntryExitAnimationFunction = () => {
  "worklet";
  return {
    initialValues: { opacity: 1, transform: [{ scale: 1 }] },
    animations: {
      opacity: withTiming(0, { duration: DURATION.exit, easing: EASE_OUT }),
      transform: [{ scale: withTiming(0.6, { duration: DURATION.exit, easing: EASE_OUT }) }],
    },
  };
};

/** The held-message count, top-trailing on the Agents capsule. Place it inside a `position: relative` parent. */
export function WaitingBadge({ count }: { count: number }) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  if (count <= 0) return null;
  return (
    <Animated.View
      pointerEvents="none"
      accessible={false}
      entering={FadeIn.duration(reduced ? DURATION.enter : DURATION.state)}
      exiting={FadeOut.duration(DURATION.exit)}
      style={{ position: "absolute", top: -6, end: -6, minWidth: 19, height: 19, alignItems: "center", justifyContent: "center" }}
    >
      <Animated.View
        entering={reduced ? undefined : badgeIn}
        exiting={reduced ? undefined : badgeOut}
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          start: 0,
          end: 0,
          borderRadius: radius.full,
          backgroundColor: colors.accent,
          // A ring of the bar's colour cuts the badge out of the capsule's edge.
          borderWidth: 1.5,
          borderColor: colors.background,
        }}
      />
      <T
        variant="caption"
        tone="onAccent"
        style={{ fontWeight: "600", fontVariant: ["tabular-nums"], lineHeight: 14, paddingHorizontal: 5 }}
      >
        {count > 99 ? "99+" : count}
      </T>
    </Animated.View>
  );
}
