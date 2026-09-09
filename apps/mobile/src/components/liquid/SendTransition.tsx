import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import { AppState, StyleSheet, View } from "react-native";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, {
  measure,
  type AnimatedRef,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  useFrameCallback,
  Easing,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { imageSource, MessagePart } from "../../features/MessagePart";
import type { UserMessage } from "../../state/protocol";
import {
  sendPartKey,
  usableSendRect,
  type SendFlight,
  type SendReceipt,
  type SendRect,
  type SendSource,
  type OutgoingSend,
  DRAFT_SEND_THREAD,
} from "../../state/sendTransition";
import { useTheme } from "../../ui/theme";
import { sendEndpointOffset, sendTravel } from "./sendGeometry";

export function measureSendView(view: View | null): Promise<SendRect | null> {
  return new Promise((resolve) => {
    if (!view) return resolve(null);
    // Native navigation can unmount a source while an RPC is pending.
    const timer = setTimeout(() => resolve(null), 100);
    try {
      view.measureInWindow((x, y, width, height) => {
        clearTimeout(timer);
        const rect = { x, y, width, height };
        resolve(usableSendRect(rect) ? rect : null);
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

type Destination = {
  bubble: SendRect;
  surface?: SendRect;
  parts: Record<string, SendRect>;
  bubbleRef: AnimatedRef<View>;
};
type PendingFlight = SendFlight & {
  destination?: Destination;
  keyboardAtSend: number;
};
type MotionContext = {
  flight: PendingFlight | null;
  outgoing: OutgoingSend | null;
  begin: (
    threadId: string | undefined,
    afterSeq: number,
    message: UserMessage,
    sources: Record<string, SendSource>,
  ) => number;
  confirm: (id: number, receipt: SendReceipt, message: UserMessage) => void;
  cancel: (id: number) => void;
  received: (id: number) => void;
  start: (
    receipt: SendReceipt,
    message: UserMessage,
    sources: Record<string, SendSource>,
  ) => void;
  land: (id: number, destination: Destination) => void;
  finish: (id: number) => void;
};
const Context = createContext<MotionContext>({
  flight: null,
  outgoing: null,
  begin: () => 0,
  confirm: () => {},
  cancel: () => {},
  received: () => {},
  start: () => {},
  land: () => {},
  finish: () => {},
});
export const useSendTransition = () => useContext(Context);

export function SendTransitionProvider({ children }: PropsWithChildren) {
  const [flight, setFlight] = useState<PendingFlight | null>(null);
  const [outgoing, setOutgoing] = useState<OutgoingSend | null>(null);
  const root = useRef<View>(null);
  const [origin, setOrigin] = useState({ x: 0, y: 0 });
  const serial = useRef(0);
  const keyboard = useReanimatedKeyboardAnimation();
  const reduced = useReducedMotion();
  const begin = useCallback(
    (
      threadId: string | undefined,
      afterSeq: number,
      message: UserMessage,
      sources: Record<string, SendSource>,
    ) => {
      const id = ++serial.current;
      const key = `outgoing-${id}`;
      const targetThread = threadId ?? DRAFT_SEND_THREAD;
      setOutgoing({
        id,
        key,
        threadId: targetThread,
        sourceThreadId: targetThread,
        afterSeq,
        message,
        sources,
        at: new Date().toISOString(),
      });
      if (
        !reduced &&
        Object.keys(sources).length &&
        message.parts.filter((part) => part.type === "text").length <= 1
      )
        setFlight({
          id,
          receipt: { threadId: targetThread, messageId: key },
          message,
          sources,
          keyboardAtSend: keyboard.height.get(),
        });
      return id;
    },
    [reduced, keyboard.height],
  );
  const confirm = useCallback(
    (id: number, receipt: SendReceipt, message: UserMessage) => {
      setOutgoing((current) =>
        current?.id === id
          ? { ...current, receipt, message, threadId: receipt.threadId }
          : current,
      );
      // A new thread adopts the already travelling message; never restart it.
      setFlight((current) =>
        current?.id === id
          ? {
              ...current,
              receipt: {
                threadId: receipt.threadId,
                messageId: `outgoing-${id}`,
              },
            }
          : current,
      );
    },
    [],
  );
  const cancel = useCallback((id: number) => {
    setOutgoing((current) => (current?.id === id ? null : current));
    setFlight((current) => (current?.id === id ? null : current));
  }, []);
  const received = useCallback((id: number) => {
    setOutgoing((current) =>
      current?.id === id && !current.received
        ? { ...current, received: true }
        : current,
    );
  }, []);
  useEffect(() => {
    if (outgoing?.received && flight?.id !== outgoing.id) setOutgoing(null);
  }, [outgoing, flight?.id]);
  const finish = useCallback(
    (id: number) =>
      setFlight((current) => (current?.id === id ? null : current)),
    [],
  );
  const start = useCallback(
    (
      receipt: SendReceipt,
      message: UserMessage,
      sources: Record<string, SendSource>,
    ) => {
      if (
        reduced ||
        !Object.keys(sources).length ||
        message.parts.filter((part) => part.type === "text").length > 1
      )
        return;
      setFlight({
        id: ++serial.current, receipt, message, sources,
        keyboardAtSend: keyboard.height.get(),
      });
    },
    [reduced, keyboard.height],
  );
  const land = useCallback((id: number, destination: Destination) => {
    setFlight((current) =>
      current?.id === id && !current.destination
        ? { ...current, destination }
        : current,
    );
  }, []);
  useEffect(() => {
    if (!flight) return;
    // A queued, unmounted, disconnected, or offscreen destination never leaves
    // a hidden row behind. No history row owns a permanent animation state.
    const timer = setTimeout(() => finish(flight.id), 1600);
    return () => clearTimeout(timer);
  }, [flight?.id, finish]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") setFlight(null);
    });
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (reduced) setFlight(null);
  }, [reduced]);
  const context = useMemo(
    () => ({
      flight,
      outgoing,
      begin,
      confirm,
      cancel,
      received,
      start,
      land,
      finish,
    }),
    [flight, outgoing, begin, confirm, cancel, received, start, land, finish],
  );
  return (
    <Context.Provider value={context}>
      <View
        ref={root}
        collapsable={false}
        style={{ flex: 1 }}
        onLayout={() => {
          void measureSendView(root.current).then((rect) => {
            if (rect) setOrigin({ x: rect.x, y: rect.y });
          });
        }}
      >
        {children}
        {flight && (
          <View
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={StyleSheet.absoluteFill}
          >
            <Flight
              key={flight.id}
              flight={flight}
              origin={origin}
              finish={finish}
            />
          </View>
        )}
      </View>
    </Context.Provider>
  );
}

function Flight({
  flight,
  origin,
  finish,
}: {
  flight: PendingFlight;
  origin: { x: number; y: number };
  finish: (id: number) => void;
}) {
  const progress = useSharedValue(0);
  const shape = useSharedValue(0);
  const settled = useSharedValue(false);
  const finished = useSharedValue(false);
  const targetPosition = useSharedValue({ x: 0, y: 0 });
  const stableFrames = useSharedValue(0);
  const previousKeyboard = useSharedValue(0);
  const keyboard = useReanimatedKeyboardAnimation();
  const { colors } = useTheme();
  const destination = flight.destination;
  const keyboardAtSend = flight.keyboardAtSend;
  const bubbleRef = destination?.bubbleRef;
  const bubbleRect = destination?.bubble;
  // One geometry read per frame, only while a send is in flight. All parts
  // share the bubble's displacement as the keyboard and list move underneath.
  useFrameCallback(() => {
    if (!bubbleRef || !bubbleRect || finished.get()) return;
    const target = measure(bubbleRef);
    if (!target) return;
    const next = {
      x: target.pageX - bubbleRect.x,
      y: target.pageY - bubbleRect.y,
    };
    const previous = targetPosition.get();
    const keyboardHeight = keyboard.height.get();
    const stable =
      Math.abs(next.x - previous.x) < 0.5 &&
      Math.abs(next.y - previous.y) < 0.5 &&
      Math.abs(keyboardHeight - previousKeyboard.get()) < 0.5;
    stableFrames.set(stable ? stableFrames.get() + 1 : 0);
    previousKeyboard.set(keyboardHeight);
    targetPosition.set(next);
    if (settled.get() && stableFrames.get() >= 2) {
      finished.set(true);
      scheduleOnRN(finish, flight.id);
    }
  });
  const tracking = useAnimatedStyle(() => {
    const target = targetPosition.get();
    const offset = sendEndpointOffset(
      progress.get(),
      keyboardAtSend,
      keyboard.height.get(),
      target.x,
      target.y,
    );
    return {
      transform: [
        { translateX: offset.x },
        { translateY: offset.y },
      ],
    };
  });
  useEffect(() => {
    if (!destination) return;
    const timing = { duration: 360, easing: Easing.bezier(0.77, 0, 0.175, 1) };
    progress.set(withTiming(1, timing));
    shape.set(
      withTiming(1, timing, (done) => {
        if (done) settled.set(true);
      }),
    );
  }, [destination, progress, shape, settled]);
  const textSurface = destination?.surface;
  const sourceText = flight.sources.text?.rect;
  const background = useAnimatedStyle(() => {
    const to = textSurface;
    const text = sourceText;
    const p = progress.get();
    const travel = sendTravel(p);
    if (!to || !text) return { opacity: p };
    const from = {
      x: text.x - 18,
      y: text.y - 12,
      width: text.width + 36,
      height: text.height + 24,
    };
    return {
      opacity: interpolate(p, [0, 0.7, 1], [0, 0.8, 1]),
      width: from.width + (to.width - from.width) * p,
      height: from.height + (to.height - from.height) * p,
      transform: [
        { translateX: (from.x - to.x) * (1 - travel.x) },
        { translateY: (from.y - to.y) * (1 - travel.y) },
      ],
    };
  });
  return (
    <Animated.View style={[StyleSheet.absoluteFill, tracking]}>
      {destination?.surface && (
        <Animated.View
          style={[
            {
              position: "absolute",
              left: destination.surface.x - origin.x,
              top: destination.surface.y - origin.y,
              width: destination.surface.width,
              height: destination.surface.height,
              backgroundColor: colors.raised,
              borderRadius: 22,
              borderBottomEndRadius: 7,
            },
            background,
          ]}
        />
      )}
      {flight.message.parts.map((part, index) => {
        const key = sendPartKey(part, index);
        const source = flight.sources[key];
        const target = destination?.parts[key];
        if (!source && !target) return null;
        return (
          <FlyingPart
            key={`${key}:${index}`}
            part={part}
            source={source}
            target={target}
            origin={origin}
            progress={progress}
            shape={shape}
          />
        );
      })}
    </Animated.View>
  );
}

function FlyingPart({
  part,
  source,
  target,
  origin,
  progress,
  shape,
}: {
  part: UserMessage["parts"][number];
  source?: SendSource;
  target?: SendRect;
  origin: { x: number; y: number };
  progress: ReturnType<typeof useSharedValue<number>>;
  shape: ReturnType<typeof useSharedValue<number>>;
}) {
  const from = source?.rect ?? target!;
  const to = target ?? from;
  const style = useAnimatedStyle(() => {
    const p = progress.get();
    const s = shape.get();
    const travel = sendTravel(p);
    return {
      opacity: source ? 1 : p,
      transform: [
        {
          translateX: (from.x + from.width / 2 - to.x - to.width / 2) * (1 - travel.x),
        },
        {
          translateY:
            (from.y + from.height / 2 - to.y - to.height / 2) * (1 - travel.y),
        },
        { scaleX: from.width / to.width + (1 - from.width / to.width) * s },
        { scaleY: from.height / to.height + (1 - from.height / to.height) * s },
      ],
    };
  });
  if (part.type === "text")
    return (
      <FlyingText
        part={part}
        from={from}
        to={to}
        origin={origin}
        progress={progress}
      />
    );
  if (imageSource(part, source?.uri))
    return (
      <FlyingImage
        part={part}
        source={source}
        from={from}
        to={to}
        origin={origin}
        progress={progress}
        shape={shape}
      />
    );
  return (
    <Animated.View
      style={[
        {
          position: "absolute",
          left: to.x - origin.x,
          top: to.y - origin.y,
          width: to.width,
          height: to.height,
          overflow: "hidden",
        },
        style,
      ]}
    >
      <MessagePart
        part={part}
        localUri={source?.uri}
        selectable={false}
        fillImage
      />
    </Animated.View>
  );
}

// The source and destination line wraps are laid out once. Crossfading them
// during travel keeps glyphs at their real size, even for a one-word message.
function FlyingText({
  part,
  from,
  to,
  origin,
  progress,
}: {
  part: UserMessage["parts"][number];
  from: SendRect;
  to: SendRect;
  origin: { x: number; y: number };
  progress: ReturnType<typeof useSharedValue<number>>;
}) {
  const position = useAnimatedStyle(() => ({
    transform: [
      { translateX: (to.x - from.x) * sendTravel(progress.get()).x },
      { translateY: (to.y - from.y) * sendTravel(progress.get()).y },
    ],
  }));
  const sourceFade = useAnimatedStyle(() => ({
    opacity: interpolate(progress.get(), [0, 0.6], [1, 0], "clamp"),
  }));
  const targetFade = useAnimatedStyle(() => ({
    opacity: interpolate(progress.get(), [0.2, 0.8], [0, 1], "clamp"),
  }));
  return (
    <Animated.View
      style={[
        {
          position: "absolute",
          left: from.x - origin.x,
          top: from.y - origin.y,
        },
        position,
      ]}
    >
      <Animated.View
        style={[
          {
            position: "absolute",
            width: from.width,
            height: from.height,
            overflow: "hidden",
          },
          sourceFade,
        ]}
      >
        <MessagePart part={part} selectable={false} />
      </Animated.View>
      <Animated.View
        style={[
          {
            position: "absolute",
            width: to.width,
            height: to.height,
            overflow: "hidden",
          },
          targetFade,
        ]}
      >
        <MessagePart part={part} selectable={false} />
      </Animated.View>
    </Animated.View>
  );
}

function FlyingImage({
  part,
  source,
  from,
  to,
  origin,
  progress,
  shape,
}: {
  part: UserMessage["parts"][number];
  source?: SendSource;
  from: SendRect;
  to: SendRect;
  origin: { x: number; y: number };
  progress: ReturnType<typeof useSharedValue<number>>;
  shape: ReturnType<typeof useSharedValue<number>>;
}) {
  const style = useAnimatedStyle(() => {
    const travel = sendTravel(progress.get());
    const width = Math.max(1, from.width + (to.width - from.width) * shape.get());
    const height = Math.max(1, from.height + (to.height - from.height) * shape.get());
    return {
      // Follow the image's center as it grows, so its size change does not
      // introduce a second trajectory on top of the right-first flight.
      width,
      height,
      borderRadius: 16 + (24 - 16) * Math.min(1, shape.get()),
      transform: [
        { translateX:
          (to.x + to.width / 2 - from.x - from.width / 2) * travel.x +
          (from.width - width) / 2 },
        { translateY:
          (to.y + to.height / 2 - from.y - from.height / 2) * travel.y +
          (from.height - height) / 2 },
      ],
    };
  });
  return (
    <Animated.Image
      fadeDuration={0}
      source={imageSource(part, source?.uri)}
      resizeMode="cover"
      style={[
        {
          position: "absolute",
          left: from.x - origin.x,
          top: from.y - origin.y,
        },
        style,
      ]}
    />
  );
}
