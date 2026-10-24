// A thread's artifacts: pages and tools it produced, as one inset list. Tap previews (or opens
// the hosted page); long-press for publishing and sharing. Claude threads can also open any
// generated file by path.
import * as Clipboard from "expo-clipboard";
import { randomUUID } from "expo-crypto";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Linking, View } from "react-native";
import {
  artifactView,
  publishArtifactPrompt,
} from "../../../../packages/kybern-client/src/artifacts";
import type { ArtifactTool, Thread } from "../state/protocol";
import { errorText, refresh, rpc } from "../state/runtime";
import type { MenuItem } from "../ui/ActionMenu";
import { InsetGroup, ListRow, SectionFooter, SectionHeader } from "../ui/List";
import { Button, Empty, ErrorBanner, Field } from "../ui/primitives";
import { showToast } from "../ui/Toast";
import { space } from "../ui/theme";
import { Working } from "../ui/Working";

const STATUS_WORD = {
  published: "Published on Claude",
  failed: "Publication failed",
  publishing: "Publishing…",
} as Record<string, string>;

export function Artifacts({ thread }: { thread: Thread }) {
  const [fileOpen, setFileOpen] = useState(false);
  const [items, setItems] = useState<ArtifactTool[]>([]);
  const [before, setBefore] = useState<number | null>(null);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [path, setPath] = useState("");
  useEffect(() => {
    let alive = true;
    setBusy(true);
    setError("");
    void rpc("threads.artifacts.list", { thread_id: thread.id })
      .then((r) => {
        if (alive) {
          setItems(r.artifacts);
          setBefore(r.next_before_seq);
        }
      })
      .catch((e) => {
        if (alive) setError(errorText(e));
      })
      .finally(() => {
        if (alive) {
          setBusy(false);
          setLoaded(true);
        }
      });
    return () => {
      alive = false;
    };
  }, [thread.id, thread.status, reload]);
  async function publish(path: string, url: string | null) {
    setBusy(true);
    setError("");
    try {
      const message = { parts: [{ type: "text" as const, text: publishArtifactPrompt({ path, url }) }] };
      if (thread.status === "running" || thread.status === "awaiting-approval") {
        await rpc("queue.add", { thread_id: thread.id, id: randomUUID(), message });
        showToast("Publishing check queued");
      } else {
        await rpc("threads.send", { thread_id: thread.id, message });
        showToast("Claude is checking its publishing tools");
      }
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function older() {
    if (before === null) return;
    setBusy(true);
    try {
      const r = await rpc("threads.artifacts.list", { thread_id: thread.id, before_seq: before });
      setItems((items) => [...items, ...r.artifacts.filter((i) => !items.some((old) => old.seq === i.seq))]);
      setBefore(r.next_before_seq);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const preview = (path: string, title: string) =>
    router.push({ pathname: "/artifact", params: { threadId: thread.id, path, title } });
  const open = (url: string) => void Linking.openURL(url).catch((e) => setError(errorText(e)));
  const views = items.flatMap((tool) => {
    const item = artifactView(tool);
    return item ? [{ seq: tool.seq, item }] : [];
  });
  const claude = thread.provider.kind === "claude-code";

  return (
    <View>
      <ErrorBanner error={error} onRetry={() => setReload((n) => n + 1)} />
      {!loaded ? (
        <Working label="Loading artifacts" />
      ) : views.length ? (
        <>
          <SectionHeader
            title="In this conversation"
            count={views.length}
            action={{ title: "Refresh", label: "Refresh artifacts", onPress: () => setReload((n) => n + 1) }}
            first
          />
          <InsetGroup>
            {views.map(({ seq, item }) => {
              const menu: MenuItem[] = [
                ...(item.path ? [{ title: "Preview", icon: "doc.text" as const, onPress: () => preview(item.path!, item.title) }] : []),
                ...(item.url
                  ? [
                      { title: "Open in Claude", icon: "arrow.up.right" as const, onPress: () => open(item.url!) },
                      { title: "Share and versions", icon: "square.and.arrow.up" as const, onPress: () => open(item.url!) },
                    ]
                  : []),
                ...(item.path && item.status !== "publishing"
                  ? [
                      {
                        title: item.url ? "Ask to update publication" : "Check publishing options",
                        icon: "sparkles" as const,
                        disabled: busy,
                        onPress: () => void publish(item.path!, item.url),
                      },
                      {
                        title: "Copy path",
                        icon: "doc.on.doc" as const,
                        onPress: () => {
                          void Clipboard.setStringAsync(item.path!);
                          showToast("Path copied");
                        },
                      },
                    ]
                  : []),
              ];
              return (
                <ListRow
                  key={seq}
                  title={item.title}
                  subtitle={[STATUS_WORD[item.status] ?? "Check publication result", item.path].filter(Boolean).join(" · ")}
                  subtitleLines={1}
                  leading="doc.text"
                  chevron={!!(item.path || item.url)}
                  menu={menu}
                  onPress={item.path ? () => preview(item.path!, item.title) : item.url ? () => open(item.url!) : undefined}
                />
              );
            })}
          </InsetGroup>
          <SectionFooter>Touch and hold an artifact to publish or share it.</SectionFooter>
          {before !== null && (
            <View style={{ alignItems: "center", paddingTop: space.lg }}>
              <Button role="plain" size="medium" disabled={busy} onPress={() => void older()}>
                Load earlier artifacts
              </Button>
            </View>
          )}
        </>
      ) : (
        <Empty
          icon="doc.text"
          title="No artifacts yet"
          detail={
            claude
              ? "Pages and tools Claude makes in this conversation appear here. You can also open a generated file below."
              : "Pages and tools this conversation makes appear here."
          }
        />
      )}
      {claude && (
        <>
          <SectionHeader title="Generated file" />
          <InsetGroup>
            <ListRow
              title="Open a file by path"
              subtitle="Preview HTML, Markdown or SVG"
              leading="doc.badge.plus"
              chevron={!fileOpen}
              onPress={() => setFileOpen((v) => !v)}
            />
          </InsetGroup>
          {fileOpen && (
            <View style={{ gap: space.md, paddingTop: space.lg }}>
              <Field
                label="File path"
                placeholder="artifacts/dashboard.html"
                autoCapitalize="none"
                autoCorrect={false}
                value={path}
                onChangeText={setPath}
              />
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
                <Button size="medium" disabled={!path.trim()} onPress={() => preview(path.trim(), path.split("/").pop() || "Artifact")}>
                  Preview
                </Button>
                <Button role="plain" size="medium" disabled={busy || !path.trim()} onPress={() => void publish(path.trim(), null)}>
                  Check publishing options
                </Button>
              </View>
            </View>
          )}
        </>
      )}
    </View>
  );
}
