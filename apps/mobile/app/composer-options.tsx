import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView } from "react-native";
import { useTheme } from "../src/ui/theme";
import { ComposerOptions } from "../src/features/ComposerControls";
import { errorText, loadThread, useApp, useThread } from "../src/state/runtime";
import { useLayout } from "../src/state/layout";
import { ErrorBanner, IconButton, Page, T, Tap } from "../src/ui/primitives";

export default function ComposerOptionsScreen() {
  const { threadId, section: requested } = useLocalSearchParams<{
    threadId?: string;
    section?: string;
  }>();
  const { colors } = useTheme();
  const { regular } = useLayout();
  const section =
    requested === "permissions" || requested === "usage" ? requested : "model";
  const app = useApp();
  const snapshot = useThread(threadId ?? "");
  const thread = app.threads.find((t) => t.id === threadId) ?? snapshot.thread;
  const [error, setError] = useState("");
  useEffect(() => {
    if (threadId && !snapshot.loaded && app.status === "open")
      void loadThread(threadId).catch((e) => setError(errorText(e)));
  }, [threadId, snapshot.loaded, app.status]);
  return (
    <>
      <Stack.Screen
        options={{
          title:
            section === "permissions"
              ? "Permissions"
              : section === "usage"
                ? "Context & usage"
                : threadId
                  ? "Model & reasoning"
                  : "Agent & model",
          // On tablet iOS centers a form sheet as a card; a full-height detent
          // fills the screen top-to-bottom so it reads as grounded, not floating.
          sheetAllowedDetents: regular
            ? [1]
            : section === "model"
              ? [0.75, 1]
              : section === "permissions"
                ? [0.65, 1]
                : [0.5, 0.75, 1],
          headerRight: () => (
            <IconButton
              name="xmark"
              label="Close composer options"
              onPress={() => router.back()}
            />
          ),
        }}
      />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0 }}
        contentContainerStyle={{
          flexGrow: 1,
          flexDirection: "row",
          paddingHorizontal: 16,
          paddingBottom: 8,
          gap: 4,
        }}
      >
        {(
          ["model", "permissions", ...(threadId ? ["usage"] : [])] as const
        ).map((tab) => (
          <Tap
            key={tab}
            label={
              tab === "model"
                ? "Model"
                : tab === "permissions"
                  ? "Permissions"
                  : "Usage"
            }
            selected={section === tab}
            onPress={() => router.setParams({ section: tab })}
            style={{
              flexGrow: 1,
              flexShrink: 0,
              paddingHorizontal: 12,
              paddingVertical: 8,
              alignItems: "center",
              borderRadius: 14,
              backgroundColor: section === tab ? colors.raised : "transparent",
            }}
          >
            <T variant="caption" tone={section === tab ? "ink" : "secondary"}>
              {tab === "model"
                ? "Model"
                : tab === "permissions"
                  ? "Permissions"
                  : "Usage"}
            </T>
          </Tap>
        ))}
      </ScrollView>
      {threadId && !thread ? (
        <Page>
          <ErrorBanner error={error} />
          <T tone="secondary">Loading thread options…</T>
        </Page>
      ) : (
        <ComposerOptions thread={thread} section={section} />
      )}
    </>
  );
}
