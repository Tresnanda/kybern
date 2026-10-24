import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Platform, View } from "react-native";
import { ComposerOptions } from "../src/features/ComposerControls";
import { errorText, loadThread, useApp, useThread } from "../src/state/runtime";
import { useLayout } from "../src/state/layout";
import { ErrorBanner, IconButton, Page, T } from "../src/ui/primitives";
import { Segmented } from "../src/ui/Segmented";
import { space, useTheme } from "../src/ui/theme";

type Section = "model" | "permissions" | "usage";

export default function ComposerOptionsScreen() {
  const { threadId, section: requested } = useLocalSearchParams<{
    threadId?: string;
    section?: string;
  }>();
  const { colors } = useTheme();
  const { regular } = useLayout();
  const section: Section =
    requested === "permissions" || requested === "usage" ? requested : "model";
  const app = useApp();
  const snapshot = useThread(threadId ?? "");
  const thread = app.threads.find((t) => t.id === threadId) ?? snapshot.thread;
  const [error, setError] = useState("");
  useEffect(() => {
    if (threadId && !snapshot.loaded && app.status === "open")
      void loadThread(threadId).catch((e) => setError(errorText(e)));
  }, [threadId, snapshot.loaded, app.status]);
  const control = (
    <Segmented<Section>
          label="Options"
          value={section}
          onChange={(tab) => router.setParams({ section: tab })}
          options={[
            { value: "model", label: "Model" },
            { value: "permissions", label: "Permissions" },
            ...(threadId ? [{ value: "usage" as const, label: "Usage" }] : []),
          ]}
        />
  );
  return (
    <>
      <Stack.Screen
        options={{
          title: threadId ? "Model & permissions" : "Agent & model",
          headerStyle: { backgroundColor: colors.grouped },
          // On tablet iOS centers a form sheet as a card; a full-height detent
          // fills the screen top-to-bottom so it reads as grounded, not floating.
          sheetAllowedDetents: regular ? [1] : section === "model" ? [0.75, 1] : [0.6, 1],
          // iOS draws the sheet's own grabber and dismisses with a drag; a Done
          // button is the platform's close for a choice sheet.
          headerRight: () =>
            Platform.OS === "ios" ? (
              <IconButton name="checkmark" label="Done" onPress={() => router.back()} />
            ) : null,
        }}
      />
      {threadId && !thread ? (
        <Page grouped>
          <ErrorBanner error={error} />
          <T tone="secondary">Loading thread options…</T>
        </Page>
      ) : (
        <ComposerOptions thread={thread} section={section} top={control} />
      )}
    </>
  );
}
