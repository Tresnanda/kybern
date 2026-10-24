import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Image,
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
import { Button, T, Tap } from "../ui/primitives";
import { ContextMenu, type MenuItem } from "../ui/ActionMenu";
import { showToast } from "../ui/Toast";
import { radius, space } from "../ui/theme";
import { groupInlineParts, inlineTextRuns } from "../state/inlineMessage";
import { createNote } from "../state/notes";
import { errorText, getState } from "../state/runtime";
import { Lightbox } from "./Lightbox";
import { LongPressArea } from "./LongPressArea";
import { editPending, retryPending, usePendingSend } from "../state/pendingSends";
import { MessagePart, imageSource } from "./MessagePart";

/** The message as text: its words and mentions, in order. */
const messageText = (parts: Extract<Block, { kind: "user" }>["message"]["parts"]) =>
  inlineTextRuns(parts.filter((part) => part.type !== "image" && part.type !== "attachment")).map((run) => run.text).join("");

/** Long-press on your own message: Copy and Save to note. */
function bubbleMenu(text: string, threadId: string): MenuItem[] {
  if (!text.trim()) return [];
  return [
    { title: "Copy", icon: "doc.on.doc", onPress: () => void Clipboard.setStringAsync(text).then(() => showToast("Copied")) },
    {
      title: "Save to note",
      icon: "doc.badge.plus",
      onPress: () => {
        const projectId = getState().threads.find((thread) => thread.id === threadId)?.project_id ?? null;
        void createNote({ projectId, body: text })
          .then((note) => showToast("Saved to a new note", { title: "Open", onPress: () => router.push({ pathname: "/note", params: { id: note.id } }) }))
          .catch((e) => showToast(errorText(e) || "Unable to save the note. Try again."));
      },
    },
  ];
}

export function UserMessageBubble({
  block,
  threadId,
}: {
  block: Extract<Block, { kind: "user" }>;
  threadId: string;
}) {
  const { colors } = useTheme();
  const { height, width, fontScale } = useWindowDimensions();
  const [viewing, setViewing] = useState<number | null>(null);
  const textSurface = useRef<View>(null);
  const { flight, outgoing, land } = useSendTransition();
  const failed = usePendingSend(threadId, block.id);
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
          gap: space.sm,
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
                    borderRadius: radius.lg,
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
          <ContextMenu items={bubbleMenu(messageText(block.message.parts), threadId)} title="Your message" surface="transparent" radius={radius.lg} style={{ alignSelf: "flex-end", maxWidth: "100%" }}>
            {({ onLongPress }) => (
          <LongPressArea onLongPress={onLongPress} hint="Long-press for Copy and Save to note">
          <View
            ref={textSurface}
            collapsable={false}
            style={{
              alignSelf: "flex-end",
              maxWidth: "100%",
              borderRadius: radius.lg,
              borderBottomEndRadius: radius.xs,
              borderCurve: "continuous",
              paddingHorizontal: 14,
              paddingVertical: 10,
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
          </LongPressArea>
            )}
          </ContextMenu>
        )}
        {failed?.state === "failed" && (
          <View style={{ alignItems: "flex-end", gap: space.xs }} accessibilityLiveRegion="polite">
            <T variant="footnote" tone="negative" style={{ textAlign: "right" }}>
              {`Not sent. ${failed.error ?? "Check the connection and try again."}`}
            </T>
            <View style={{ flexDirection: "row", gap: space.sm }}>
              <Button size="medium" role="plain" onPress={() => editPending(failed)}>
                Edit
              </Button>
              <Button size="medium" onPress={() => void retryPending(failed)}>
                Try again
              </Button>
            </View>
          </View>
        )}
        {failed?.state === "sending" && (
          <T variant="caption" tone="muted" accessibilityLiveRegion="polite" style={{ alignSelf: "flex-end", marginTop: -space.xs }}>
            Sending…
          </T>
        )}
        {pending && !pending.receipt && !matching && (
          <T
            variant="caption"
            tone="muted"
            accessibilityLiveRegion="polite"
            style={{ alignSelf: "flex-end", marginTop: -space.xs }}
          >
            Sending…
          </T>
        )}
      </Animated.View>
      {viewing !== null && (
        <Lightbox
          source={imageSource(block.message.parts[viewing]!, localUris.current.get(viewing))}
          label="Attached image"
          onClose={() => setViewing(null)}
        />
      )}
    </>
  );
}
