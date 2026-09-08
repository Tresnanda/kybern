import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ComposerOptions } from "../src/features/ComposerControls";
import { errorText, loadThread, useApp, useThread } from "../src/state/runtime";
import { ErrorBanner, IconButton, Page, T } from "../src/ui/primitives";

export default function ComposerOptionsScreen() {
  const { threadId, section: requested } = useLocalSearchParams<{
    threadId?: string;
    section?: string;
  }>();
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
          sheetAllowedDetents:
            section === "model"
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
