import { useCallback, useEffect, useRef } from "react";
import { View, useWindowDimensions } from "react-native";
import Animated, { useAnimatedRef } from "react-native-reanimated";
import {
  measureSendView,
  useSendTransition,
} from "../components/liquid/SendTransition";
import {
  matchesSend,
  sendPartKey,
  type SendRect,
} from "../state/sendTransition";
import type { Block } from "../state/transcript";
import { useTheme } from "../ui/theme";
import { MessagePart } from "./MessagePart";

export function UserMessageBubble({
  block,
  threadId,
}: {
  block: Extract<Block, { kind: "user" }>;
  threadId: string;
}) {
  const { colors } = useTheme();
  const { height } = useWindowDimensions();
  const { flight, land, finish } = useSendTransition();
  const bubble = useAnimatedRef<View>();
  const parts = useRef(new Map<string, View>());
  const matching =
    !!flight && matchesSend(flight, threadId, block.id, block.message);
  const measure = useCallback(async () => {
    if (!matching || !flight || flight.destination) return;
    const bounds = await measureSendView(bubble.current);
    if (!bounds || bounds.y + bounds.height <= 0 || bounds.y >= height) {
      finish(flight.id);
      return;
    }
    const measured: Record<string, SendRect> = {};
    await Promise.all(
      [...parts.current].map(async ([key, view]) => {
        const rect = await measureSendView(view);
        if (rect) measured[key] = rect;
      }),
    );
    land(flight.id, { bubble: bounds, parts: measured, bubbleRef: bubble });
  }, [matching, flight, height, finish, land]);
  useEffect(() => {
    if (!matching) return;
    // Let the cleared composer and the list's follow-to-end settle first.
    let next = 0;
    const frame = requestAnimationFrame(() => {
      next = requestAnimationFrame(() => {
        void measure();
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(next);
    };
  }, [matching, measure]);
  return (
    <View
      style={{
        alignSelf: "flex-end",
        maxWidth: "94%",
        marginTop: 22,
        marginBottom: 24,
      }}
    >
      <Animated.View
        ref={bubble}
        collapsable={false}
        style={{
          borderRadius: 22,
          borderBottomEndRadius: 7,
          paddingHorizontal: 18,
          paddingVertical: 14,
          backgroundColor: colors.raised,
          gap: 8,
          opacity: matching ? 0 : 1,
        }}
      >
        {block.message.parts.map((part, index) => {
          const key = sendPartKey(part, index);
          const targetKey =
            matching && flight?.message.parts[index]
              ? sendPartKey(flight.message.parts[index]!, index)
              : key;
          return (
            <View
              key={`${key}:${index}`}
              collapsable={false}
              ref={(view) => {
                if (view) parts.current.set(targetKey, view);
                else parts.current.delete(targetKey);
              }}
            >
              <MessagePart part={part} />
            </View>
          );
        })}
      </Animated.View>
    </View>
  );
}
