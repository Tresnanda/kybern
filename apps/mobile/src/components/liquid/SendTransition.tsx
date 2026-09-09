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
import Animated, {
  measure,
  type AnimatedRef,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
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
} from "../../state/sendTransition";
import { useTheme } from "../../ui/theme";

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
  parts: Record<string, SendRect>;
  bubbleRef: AnimatedRef<View>;
};
type PendingFlight = SendFlight & { destination?: Destination };
type MotionContext = {
  flight: PendingFlight | null;
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
  start: () => {},
  land: () => {},
  finish: () => {},
});
export const useSendTransition = () => useContext(Context);

export function SendTransitionProvider({ children }: PropsWithChildren) {
  const [flight, setFlight] = useState<PendingFlight | null>(null);
  const root = useRef<View>(null);
  const [origin, setOrigin] = useState({ x: 0, y: 0 });
  const serial = useRef(0);
  const reduced = useReducedMotion();
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
      setFlight({ id: ++serial.current, receipt, message, sources });
    },
    [reduced],
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
    () => ({ flight, start, land, finish }),
    [flight, start, land, finish],
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
  const { colors } = useTheme();
  const destination = flight.destination;
  const bubbleRef = destination?.bubbleRef;
  const bubbleRect = destination?.bubble;
  // One geometry read per frame, only while a send is in flight. All parts
  // share the bubble's displacement as the keyboard and list move underneath.
  const tracking = useAnimatedStyle(() => {
    const target = _WORKLET && bubbleRef ? measure(bubbleRef) : null;
    const weight = progress.get();
    return {
      transform: [
        {
          translateX:
            target && bubbleRect ? (target.pageX - bubbleRect.x) * weight : 0,
        },
        {
          translateY:
            target && bubbleRect ? (target.pageY - bubbleRect.y) * weight : 0,
        },
      ],
    };
  });
  useEffect(() => {
    if (!destination) return;
    progress.set(withSpring(1, { duration: 300, dampingRatio: 1 }));
    shape.set(
      withSpring(1, { duration: 400, dampingRatio: 0.8 }, (done) => {
        if (done) scheduleOnRN(finish, flight.id);
      }),
    );
  }, [destination, flight.id, finish, progress, shape]);
  const background = useAnimatedStyle(() => ({
    opacity: interpolate(progress.get(), [0, 0.7, 1], [0, 0.8, 1]),
  }));
  return (
    <Animated.View style={[StyleSheet.absoluteFill, tracking]}>
      {destination && (
        <Animated.View
          style={[
            {
              position: "absolute",
              left: destination.bubble.x - origin.x,
              top: destination.bubble.y - origin.y,
              width: destination.bubble.width,
              height: destination.bubble.height,
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
    return {
      opacity: source ? 1 : p,
      transform: [
        {
          translateX: (from.x + from.width / 2 - to.x - to.width / 2) * (1 - p),
        },
        {
          translateY:
            (from.y + from.height / 2 - to.y - to.height / 2) * (1 - p),
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
      { translateX: (to.x - from.x) * progress.get() },
      { translateY: (to.y - from.y) * progress.get() },
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
  const style = useAnimatedStyle(() => ({
    // This is an absolute image leaf, so changing its bounds cannot reflow the
    // composer or list. Contain preserves the photograph's aspect ratio.
    width: Math.max(1, from.width + (to.width - from.width) * shape.get()),
    height: Math.max(1, from.height + (to.height - from.height) * shape.get()),
    borderRadius: 16 + (12 - 16) * Math.min(1, shape.get()),
    transform: [
      { translateX: (to.x - from.x) * progress.get() },
      { translateY: (to.y - from.y) * progress.get() },
    ],
  }));
  return (
    <Animated.Image
      source={imageSource(part, source?.uri)}
      resizeMode="contain"
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
