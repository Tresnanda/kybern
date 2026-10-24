import { Stack, useLocalSearchParams } from "expo-router";
import { IntegrationsSettings } from "../src/features/settings/Integrations";
import type { ProviderKind } from "../src/state/protocol";
import { useApp, useThread } from "../src/state/runtime";
import { Page } from "../src/ui/primitives";

export default function Integrations() {
  const params = useLocalSearchParams<{ threadId?: string; projectId?: string; provider?: string }>();
  const app = useApp();
  const snapshot = useThread(params.threadId ?? "");
  const thread = app.threads.find((t) => t.id === params.threadId) ?? snapshot.thread ?? undefined;
  return (
    <Page grouped>
      <Stack.Screen options={{ title: "Plugins and connectors" }} />
      <IntegrationsSettings
        thread={thread}
        projectId={params.projectId}
        provider={params.provider as ProviderKind | undefined}
      />
    </Page>
  );
}
