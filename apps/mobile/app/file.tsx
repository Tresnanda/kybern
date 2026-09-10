import * as Clipboard from "expo-clipboard";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChatFileContext } from "../src/state/chatFileContext";
import { ScrollView, View, useWindowDimensions } from "react-native";
import type { FilesReadResult } from "../src/state/protocol";
import { errorText, rpc } from "../src/state/runtime";
import { addContext } from "../src/state/draft";
import { Markdown } from "../src/ui/Markdown";
import { SourceCode } from "../src/ui/SourceCode";
import {
  Button,
  Empty,
  ErrorBanner,
  IconButton,
  T,
  Tap,
  styles,
} from "../src/ui/primitives";
import { useTheme } from "../src/ui/theme";
import { Working } from "../src/ui/Working";
export default function FileScreen() {
  const { projectId, threadId, path, scope, line } = useLocalSearchParams<{
    projectId: string;
    threadId?: string;
    path: string;
    scope?: string;
    line?: string;
  }>();
  const [file, setFile] = useState<FilesReadResult>();
  const [raw, setRaw] = useState(!!line);
  const scroll = useRef<ScrollView>(null);
  const { fontScale } = useWindowDimensions();
  const fileContext = useMemo(() => threadId ? { threadId, projectId, basePath: path, scope: scope === "thread" ? "thread" as const : "project" as const } : null, [threadId, projectId, path, scope]);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const { colors } = useTheme();
  const language = path.split(".").at(-1)?.toLowerCase() ?? "";
  const markdown = /^(md|mdx|markdown)$/.test(language);
  useEffect(() => {
    let alive = true;
    setError("");
    setFile(undefined);
    void (async () => scope === "thread" && threadId
      ? rpc("threads.files.read", { thread_id: threadId, path, max_bytes: 128000 })
      : rpc("files.read", { project_id: projectId, path, max_bytes: 128000 }))()
      .then((data) => {
        if (alive) setFile(data);
      })
      .catch((e) => {
        if (alive) setError((e as { code?: number }).code === -32601 ? "Update Kybern on the connected computer to open chat file links." : errorText(e));
      });
    return () => {
      alive = false;
    };
  }, [projectId, threadId, scope, path, retry]);
  return (
    <ChatFileContext value={fileContext}><View style={{ flex: 1 }}>
      <Stack.Screen
        options={{
          title: path.split("/").at(-1) ?? "File",
          headerRight: () => (
            <IconButton
              name="doc.on.doc"
              label="Copy file contents"
              disabled={!file || file.binary}
              onPress={() => void Clipboard.setStringAsync(file?.content ?? "")}
            />
          ),
        }}
      />
      <View style={{ paddingHorizontal: 20, paddingVertical: 10, gap: 12 }}>
        <T variant="caption" tone="secondary" selectable>
          {path}{line ? ` · Line ${line}` : ""}
        </T>
        {markdown && (
          <View
            style={[
              styles.line,
              { backgroundColor: colors.raised, padding: 3, borderRadius: 14 },
            ]}
          >
            {[false, true].map((source) => (
              <Tap
                key={String(source)}
                label={source ? "Show raw Markdown" : "Show rendered Markdown"}
                selected={raw === source}
                onPress={() => setRaw(source)}
                style={{
                  flex: 1,
                  alignItems: "center",
                  borderRadius: 11,
                  backgroundColor: raw === source ? colors.surface : undefined,
                }}
              >
                <T variant="caption">{source ? "Raw" : "Preview"}</T>
              </Tap>
            ))}
          </View>
        )}
      </View>
      <ScrollView
        ref={scroll}
        onContentSizeChange={() => {
          const target = Number(line);
          if (file && raw && Number.isSafeInteger(target) && target > 0) scroll.current?.scrollTo({ y: Math.max(0, (target - 1) * 21 * fontScale), animated: false });
        }}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 24 }}
      >
        <ErrorBanner error={error} onRetry={() => setRetry((n) => n + 1)} />
        {!file && !error ? (
          <Working label="Opening file" />
        ) : file?.binary ? (
          <Empty
            title="Binary file"
            detail="This file cannot be displayed as text."
          />
        ) : file ? (
          markdown && !raw ? (
            <View style={{ paddingHorizontal: 20 }}>
              <Markdown text={file.content} />
            </View>
          ) : (
            <SourceCode text={file.content} language={language} />
          )
        ) : null}
        {file?.truncated && (
          <T variant="caption" tone="secondary" style={{ padding: 20 }}>
            Showing the first 128 KB.
          </T>
        )}
      </ScrollView>
      <View
        style={{ paddingHorizontal: 20, paddingTop: 10, paddingBottom: 30 }}
      >
        <Button
          secondary
          onPress={() => {
            addContext(threadId ?? "new", { type: "file_mention", path });
            if (threadId)
              router.dismissTo({
                pathname: "/thread/[id]",
                params: { id: threadId },
              });
            else router.dismissTo("/");
          }}
        >
          Add to message
        </Button>
      </View>
    </View></ChatFileContext>
  );
}
