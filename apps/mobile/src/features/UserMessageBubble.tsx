import { useCallback, useEffect, useRef, useState } from "react";
import {
  Image,
  Modal,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
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
import { T, Tap, IconButton } from "../ui/primitives";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { groupInlineParts, inlineTextRuns } from "../state/inlineMessage";
import { MessagePart, imageSource } from "./MessagePart";

export function UserMessageBubble({
  block,
  threadId,
}: {
  block: Extract<Block, { kind: "user" }>;
  threadId: string;
}) {
  const { colors } = useTheme();
  const { height, width, fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [viewing, setViewing] = useState<number | null>(null);
  const textSurface = useRef<View>(null);
  const { flight, outgoing, land } = useSendTransition();
  const pending =
    outgoing?.key === block.id && outgoing.threadId === threadId
      ? outgoing
      : null;
  const localUris = useRef(new Map<number, string>());
  if (pending)
    pending.message.parts.forEach((part, index) => {
      const uri = pending.sources[sendPartKey(part, index)]?.uri;
      if (uri) localUris.current.set(index, uri);
    });
  const bubble = useAnimatedRef<View>();
  const parts = useRef(new Map<string, View>());
  const matching =
    !!flight && matchesSend(flight, threadId, block.id, block.message);
  const measure = useCallback(async () => {
    if (!matching || !flight || flight.destination) return;
    // Measure the complete destination together. Serial bridge round trips
    // sampled different keyboard frames and left the source waiting in midair.
    const entries = [...parts.current];
    const [bounds, surface, ...rects] = await Promise.all([
      measureSendView(bubble.current),
      measureSendView(textSurface.current),
      ...entries.map(([, view]) => measureSendView(view)),
    ]);
    if (!bounds || bounds.y + bounds.height <= 0 || bounds.y >= height) return;
    const measured: Record<string, SendRect> = {};
    rects.forEach((rect, index) => {
      if (rect) measured[entries[index]![0]] = rect;
    });
    land(flight.id, {
      bubble: bounds,
      surface: surface ?? undefined,
      parts: measured,
      bubbleRef: bubble,
    });
  }, [matching, flight, height, land]);
  useEffect(() => {
    if (!matching) return;
    void measure();
  }, [matching, measure]);
  const images = block.message.parts
    .map((part, index) => ({ part, index }))
    .filter(
      ({ part }) =>
        part.type === "image" ||
        (part.type === "attachment" && part.media_type.startsWith("image/")),
    );
  const body = block.message.parts
    .map((part, index) => ({ part, index }))
    .filter(({ index }) => !images.some((image) => image.index === index));
  const tileSize = Math.min(220, (width - 48) * 0.72);
  const register = (index: number, view: View | null) => {
    const part = matching
      ? flight?.message.parts[index]
      : block.message.parts[index];
    if (!part) return;
    const key = sendPartKey(part, index);
    if (view) parts.current.set(key, view);
    else parts.current.delete(key);
  };
  return (
    <>
      <Animated.View
        ref={bubble}
        collapsable={false}
        onLayout={() => {
          void measure();
        }}
        style={{
          alignSelf: "flex-end",
          maxWidth: "94%",
          width: images.length > 1 ? "100%" : undefined,
          marginTop: 22,
          marginBottom: 24,
          gap: 8,
          opacity: matching ? 0 : 1,
        }}
      >
        {images.length > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={images.length > 1}
            accessibilityLabel={
              images.length > 1
                ? `${images.length} attached images. Swipe horizontally to browse`
                : undefined
            }
            style={{ alignSelf: "flex-end", maxWidth: "100%" }}
            contentContainerStyle={{ gap: 10 }}
          >
            {images.map(({ part, index }) => (
              <Tap
                key={index}
                label={`Open image ${images.findIndex((image) => image.index === index) + 1} of ${images.length}`}
                onPress={() => setViewing(index)}
                static
                style={{ width: tileSize, height: tileSize }}
              >
                <View
                  collapsable={false}
                  ref={(view) => register(index, view)}
                  style={{
                    width: tileSize,
                    height: tileSize,
                    borderRadius: 24,
                    borderCurve: "continuous",
                    overflow: "hidden",
                    backgroundColor: colors.raised,
                  }}
                >
                  <Image
                    source={imageSource(part, localUris.current.get(index))}
                    fadeDuration={0}
                    resizeMode="cover"
                    style={{ width: "100%", height: "100%" }}
                  />
                </View>
              </Tap>
            ))}
          </ScrollView>
        )}
        {body.length > 0 && (
          <View
            ref={textSurface}
            collapsable={false}
            style={{
              alignSelf: "flex-end",
              maxWidth: "100%",
              borderRadius: 22,
              borderBottomEndRadius: 7,
              paddingHorizontal: 18,
              paddingVertical: 12,
              backgroundColor: colors.raised,
              gap: 8,
            }}
          >
            {groupInlineParts(body).map(({ inline, entries }) => (
              <View
                key={entries[0]!.index}
                collapsable={false}
                ref={(view) => {
                  for (const { index } of entries) register(index, view);
                }}
              >
                {inline ? (
                  <T key={fontScale} selectable>
                    {inlineTextRuns(entries.map(({ part }) => part)).map(
                      (run, index) => (
                        <Text
                          key={index}
                          style={
                            run.highlighted
                              ? {
                                  color: colors.accent,
                                  backgroundColor: colors.accentSoft,
                                }
                              : undefined
                          }
                        >
                          {run.text}
                        </Text>
                      ),
                    )}
                  </T>
                ) : (
                  <MessagePart
                    part={entries[0]!.part}
                    localUri={localUris.current.get(entries[0]!.index)}
                  />
                )}
              </View>
            ))}
          </View>
        )}
        {pending && !pending.receipt && !matching && (
          <T
            variant="caption"
            tone="muted"
            accessibilityLiveRegion="polite"
            style={{ position: "absolute", right: 0, bottom: -23 }}
          >
            Sending…
          </T>
        )}
      </Animated.View>
      {viewing !== null && (
        <Modal
          visible
          transparent={false}
          animationType="fade"
          onRequestClose={() => setViewing(null)}
        >
          <View
            style={{ flex: 1, backgroundColor: colors.background }}
            accessibilityViewIsModal
          >
            <Image
              source={imageSource(
                block.message.parts[viewing]!,
                localUris.current.get(viewing),
              )}
              accessibilityLabel="Full attached image"
              resizeMode="contain"
              fadeDuration={0}
              style={{ flex: 1, width: "100%" }}
            />
            <View
              style={{ position: "absolute", top: insets.top + 8, right: 16 }}
            >
              <IconButton
                name="xmark"
                label="Close image"
                onPress={() => setViewing(null)}
              />
            </View>
          </View>
        </Modal>
      )}
    </>
  );
}
