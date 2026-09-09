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
import {
  Button,
  ErrorBanner,
  Field,
  Icon,
  IconButton,
  Tap,
  T,
} from "../ui/primitives";

import { useTheme } from "../ui/theme";

export function Artifacts({ thread }: { thread: Thread }) {
  const { colors, dark } = useTheme();
  const [fileOpen, setFileOpen] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [items, setItems] = useState<ArtifactTool[]>([]);
  const [before, setBefore] = useState<number | null>(null);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
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
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [thread.id, thread.status, reload]);
  async function publish(path: string, url: string | null) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const message = {
        parts: [
          { type: "text" as const, text: publishArtifactPrompt({ path, url }) },
        ],
      };
      if (
        thread.status === "running" ||
        thread.status === "awaiting-approval"
      ) {
        await rpc("queue.add", {
          thread_id: thread.id,
          id: randomUUID(),
          message,
        });
        setNotice("Publishing capability check queued.");
      } else {
        await rpc("threads.send", { thread_id: thread.id, message });
        setNotice("Claude is checking which publishing tools are available.");
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
      const r = await rpc("threads.artifacts.list", {
        thread_id: thread.id,
        before_seq: before,
      });
      setItems((items) => [
        ...items,
        ...r.artifacts.filter((i) => !items.some((old) => old.seq === i.seq)),
      ]);
      setBefore(r.next_before_seq);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  function preview(path: string, title: string) {
    router.push({
      pathname: "/artifact",
      params: { threadId: thread.id, path, title },
    });
  }
  const open = (url: string) =>
    void Linking.openURL(url).catch((e) => setError(errorText(e)));
  return (
    <View style={{ gap: 20 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View style={{ flex: 1, gap: 4 }}>
          <T variant="heading">Artifacts</T>
          <T variant="caption" tone="secondary">
            Pages and tools from this conversation
          </T>
        </View>
        <IconButton
          name="arrow.clockwise"
          label="Refresh artifacts"
          disabled={busy}
          onPress={() => setReload((n) => n + 1)}
        />
      </View>
      <ErrorBanner error={error} />
      {!!notice && (
        <T variant="caption" tone="secondary">
          {notice}
        </T>
      )}
      {thread.provider.kind === "claude-code" && (
        <View
          style={{
            padding: 16,
            borderRadius: 20,
            backgroundColor: dark ? colors.surface : colors.raised,
            gap: 12,
          }}
        >
          <Tap
            label="Open a generated file"
            expanded={fileOpen}
            static
            onPress={() => setFileOpen((v) => !v)}
            style={{ flexDirection: "row", alignItems: "center", gap: 12 }}
          >
            <Icon name="doc.badge.plus" size={22} />
            <View style={{ flex: 1, gap: 3 }}>
              <T variant="label">Open a generated file</T>
              <T variant="caption" tone="secondary">
                Preview HTML or Markdown
              </T>
            </View>
            <Icon name={fileOpen ? "chevron.up" : "plus"} size={16} />
          </Tap>
          {fileOpen && (
            <>
              <Field
                label="File path"
                placeholder="artifacts/dashboard.html"
                autoCapitalize="none"
                autoCorrect={false}
                value={path}
                onChangeText={setPath}
              />
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                <Tap
                  label="Preview file"
                  disabled={!path.trim()}
                  onPress={() =>
                    preview(path.trim(), path.split("/").pop() || "Artifact")
                  }
                  style={{
                    paddingHorizontal: 16,
                    borderRadius: 14,
                    backgroundColor: colors.ink,
                  }}
                >
                  <T variant="label" tone="inverse">
                    Preview
                  </T>
                </Tap>
                <Tap
                  label="Check publishing options"
                  disabled={busy || !path.trim()}
                  onPress={() => void publish(path.trim(), null)}
                  style={{
                    paddingHorizontal: 16,
                    borderRadius: 14,
                    backgroundColor: dark ? colors.raised : colors.surface,
                  }}
                >
                  <T variant="label">Check publishing options</T>
                </Tap>
              </View>
            </>
          )}
        </View>
      )}
      {!items.length && (
        <View style={{ paddingVertical: 32, gap: 12, alignItems: "center" }}>
          <Icon name="doc.text" size={32} color={colors.muted} />
          <T variant="heading">
            {busy ? "Loading artifacts…" : "Your work will appear here"}
          </T>
          {!busy && (
            <T
              variant="caption"
              tone="secondary"
              style={{ textAlign: "center", maxWidth: 280 }}
            >
              Preview a local HTML, Markdown, or SVG file. Hosting requires a
              publishing tool available to Claude; local previews stay on your
              computer.
            </T>
          )}
        </View>
      )}
      {items.map((tool) => {
        const item = artifactView(tool);
        if (!item) return null;
        const isExpanded = expanded === tool.seq;
        return (
          <View
            key={tool.seq}
            style={{
              backgroundColor: dark ? colors.surface : colors.raised,
              borderRadius: 20,
              padding: 16,
              gap: 16,
            }}
          >
            <View
              style={{ flexDirection: "row", alignItems: "center", gap: 12 }}
            >
              <View
                style={{
                  width: 44,
                  height: 52,
                  borderRadius: 10,
                  backgroundColor: dark ? colors.raised : colors.surface,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Icon name="doc.text" size={24} />
              </View>
              <View style={{ flex: 1, gap: 4 }}>
                <T variant="label">{item.title}</T>
                <T
                  variant="caption"
                  tone={item.status === "failed" ? "negative" : "secondary"}
                >
                  {item.status === "published"
                    ? "Published on Claude"
                    : item.status === "failed"
                      ? "Publication failed"
                      : item.status === "publishing"
                        ? "Publishing…"
                        : "Check publication result"}
                </T>
              </View>
              <IconButton
                name="ellipsis"
                label={`Manage ${item.title}`}
                onPress={() => setExpanded(isExpanded ? null : tool.seq)}
              />
            </View>
            {!!item.path && (
              <T variant="caption" tone="secondary" numberOfLines={2}>
                {item.path}
              </T>
            )}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {item.path && (
                <Tap
                  label={`Preview ${item.title}`}
                  onPress={() => preview(item.path!, item.title)}
                  style={{
                    paddingHorizontal: 16,
                    borderRadius: 14,
                    backgroundColor: dark ? colors.raised : colors.surface,
                  }}
                >
                  <T variant="label">Preview</T>
                </Tap>
              )}
              {item.url && (
                <Tap
                  label="Open in Claude"
                  onPress={() => open(item.url!)}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 6,
                    paddingHorizontal: 12,
                  }}
                >
                  <T variant="label">Open in Claude</T>
                  <Icon name="arrow.up.right" size={14} />
                </Tap>
              )}
            </View>
            {isExpanded && (
              <View style={{ gap: 8 }}>
                {item.url && (
                  <Tap
                    label="Share and versions"
                    onPress={() => open(item.url!)}
                  >
                    <T variant="label">Share and versions</T>
                  </Tap>
                )}
                {item.path && item.status !== "publishing" && (
                  <Tap
                    label={
                      item.url
                        ? "Ask to update publication"
                        : "Check publishing options"
                    }
                    disabled={busy}
                    onPress={() => void publish(item.path!, item.url)}
                  >
                    <T variant="label">
                      {item.url
                        ? "Ask to update publication"
                        : "Check publishing options"}
                    </T>
                  </Tap>
                )}
              </View>
            )}
          </View>
        );
      })}
      {before !== null && (
        <Button secondary disabled={busy} onPress={() => void older()}>
          Load earlier artifacts
        </Button>
      )}
    </View>
  );
}
