// Watch an agent use an app on the computer: the last frame it saw, refreshed
// about once a second while this screen is in front. Frames are never stored.
import { Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { AppState, Image, View, useWindowDimensions } from "react-native";
import type { ComputerFrame } from "../src/state/protocol";
import { pollFrames } from "../src/state/computerUse";
import { useApp } from "../src/state/runtime";
import { Empty, Page, T } from "../src/ui/primitives";
import { CONTENT_MAX_WIDTH, gutter, radius, space, useTheme } from "../src/ui/theme";

export default function ComputerLiveScreen() {
  const { threadId } = useLocalSearchParams<{ threadId: string }>();
  const app = useApp();
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const thread = app.threads.find((t) => t.id === threadId);
  const [frame, setFrame] = useState<ComputerFrame | null>(null);
  const [active, setActive] = useState(AppState.currentState === "active");
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => setActive(next === "active"));
    return () => sub.remove();
  }, []);
  useFocusEffect(
    useCallback(() => {
      if (!threadId || !active || app.status !== "open") return;
      return pollFrames(threadId, setFrame);
    }, [threadId, active, app.status]),
  );
  const available = Math.min(width, CONTENT_MAX_WIDTH) - gutter(width) * 2;
  const height = frame ? Math.min((available * frame.height) / Math.max(1, frame.width), 640) : 0;
  return (
    <Page grouped>
      <Stack.Screen options={{ title: thread?.title || "Live view" }} />
      {!frame ? (
        <Empty
          icon="display"
          title="Nothing to show yet"
          detail="The agent's view appears here the next time it uses an app."
        />
      ) : (
        <View style={{ gap: space.sm }}>
          <Image
            source={{ uri: `data:${frame.media_type};base64,${frame.data}` }}
            accessibilityLabel={`${frame.app}${frame.title ? `, ${frame.title}` : ""}`}
            resizeMode="contain"
            style={{ width: available, height, borderRadius: radius.md, backgroundColor: colors.raised }}
          />
          <T variant="subhead">{frame.title ? `${frame.app} · ${frame.title}` : frame.app}</T>
          {frame.action ? (
            <T variant="footnote" tone="secondary">
              {frame.action}
            </T>
          ) : null}
        </View>
      )}
    </Page>
  );
}
