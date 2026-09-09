import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { WebView } from "react-native-webview";
import { httpBase } from "../../../packages/kybern-client/src/address";
import {
  activeEnvironment,
  errorText,
  rpc,
  useApp,
} from "../src/state/runtime";
import { Markdown } from "../src/ui/Markdown";
import { Tap, Icon, ErrorBanner, T } from "../src/ui/primitives";
import { useTheme } from "../src/ui/theme";

export default function ArtifactPreview() {
  const { threadId, path, title } = useLocalSearchParams<{
    threadId: string;
    path: string;
    title?: string;
  }>();
  const { colors } = useTheme();
  const app = useApp();
  const [source, setSource] = useState<string | null>(null);
  const [uri, setUri] = useState("");
  const [error, setError] = useState("");
  const [code, setCode] = useState(false);
  const markdown = /\.(md|markdown)$/i.test(path ?? "");
  useEffect(() => {
    let alive = true;
    const environment = activeEnvironment();
    setSource(null);
    setUri("");
    setError("");
    void rpc("threads.artifacts.read", { thread_id: threadId, path })
      .then(async (result) => {
        if (result.binary || result.truncated)
          throw new Error(
            "This file is binary or larger than 1 MB. Open the hosted artifact instead.",
          );
        if (alive) setSource(result.content);
        if (!markdown && environment) {
          const result = await rpc("threads.artifacts.preview", {
            thread_id: threadId,
            path,
          });
          if (alive)
            setUri(
              `${httpBase(environment.url)}/artifact-preview/${encodeURIComponent(result.ticket)}`,
            );
        }
      })
      .catch((e) => {
        if (alive) setError(errorText(e));
      });
    return () => {
      alive = false;
    };
  }, [threadId, path, markdown, app.activeId]);
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen options={{ title: title ?? "Artifact" }} />
      <View style={{ paddingHorizontal: 16, paddingVertical: 8, gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <View style={{ flex: 1, gap: 2 }}>
            <T variant="caption" tone="secondary" numberOfLines={1}>
              {path?.split("/").pop()}
            </T>
            <T variant="caption" tone="muted">
              Local preview
            </T>
          </View>
          <Tap
            label={code ? "Show preview" : "View source"}
            selected={code}
            static
            onPress={() => setCode((v) => !v)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              paddingHorizontal: 12,
              borderRadius: 14,
              backgroundColor: colors.surface,
            }}
          >
            <Icon name={code ? "doc.text" : "terminal"} size={16} />
            <T variant="caption">{code ? "Preview" : "Source"}</T>
          </Tap>
        </View>
        <ErrorBanner error={error} />
      </View>
      {source === null ? (
        !error && <T style={{ padding: 16 }}>Loading preview…</T>
      ) : (
        <>
          {/* Keep the WebView mounted when viewing source: preview tickets are single-use. */}
          {!markdown && !!uri && (
            <View
              style={{
                flex: code ? 0 : 1,
                height: code ? 0 : undefined,
                overflow: "hidden",
              }}
              pointerEvents={code ? "none" : "auto"}
            >
              <WebView
                source={{ uri }}
                originWhitelist={[
                  httpBase(activeEnvironment()?.url ?? "http://localhost"),
                ]}
                onShouldStartLoadWithRequest={(request) =>
                  request.url === uri || request.url === "about:blank"
                }
                javaScriptEnabled
                domStorageEnabled={false}
                sharedCookiesEnabled={false}
                thirdPartyCookiesEnabled={false}
                allowFileAccess={false}
                allowFileAccessFromFileURLs={false}
                allowUniversalAccessFromFileURLs={false}
                setSupportMultipleWindows={false}
                onError={(event) => setError(event.nativeEvent.description)}
                style={{ flex: 1, backgroundColor: "white" }}
              />
            </View>
          )}
          {(code || markdown) && (
            <ScrollView contentContainerStyle={{ padding: 16 }}>
              {code ? (
                <T variant="mono" selectable>
                  {source}
                </T>
              ) : (
                <Markdown text={source} />
              )}
            </ScrollView>
          )}
        </>
      )}
    </View>
  );
}
