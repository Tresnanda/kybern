import * as Clipboard from "expo-clipboard";
import { memo, useState } from "react";
import { Image, Share, View } from "react-native";
import { Alert } from "../ui/Alert";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { httpBase } from "../state/protocol";
import {
  activeEnvironment,
  errorText,
  loadThread,
  rpc,
} from "../state/runtime";
import { type Block } from "../state/transcript";
import { Code, Markdown } from "../ui/Markdown";
import { Icon, IconButton, T, Tap, styles } from "../ui/primitives";
import { useStreamedText } from "../ui/useStreamedText";
import { useTheme } from "../ui/theme";
import { TaskRow } from "./Tasks";
import { ApprovalPanel } from "./Approvals";

function toolSummary(block: Extract<Block, { kind: "tool" }>) {
  const input =
    block.call.input && typeof block.call.input === "object"
      ? (block.call.input as Record<string, unknown>)
      : {};
  const path =
    input.file_path ??
    input.path ??
    input.command ??
    input.pattern ??
    input.description;
  return typeof path === "string" ? path : block.call.name;
}
export const TranscriptBlock = memo(function TranscriptBlock({
  block,
  threadId,
  active = true,
  expansions,
  grouped = false,
}: {
  block: Block;
  threadId: string;
  active?: boolean;
  expansions?: Map<string, boolean>;
  grouped?: boolean;
}) {
  const { colors } = useTheme();
  const expansionKey = `${block.kind}:${block.id}`;
  const [expanded, setExpandedValue] = useState(
    () => expansions?.get(expansionKey) ?? false,
  );
  const setExpanded = (value: boolean) => {
    expansions?.set(expansionKey, value);
    setExpandedValue(value);
  };
  const [copied, setCopied] = useState(false);
  switch (block.kind) {
    case "user":
      return (
        <View
          style={{
            alignSelf: "flex-end",
            maxWidth: "94%",
            borderRadius: 22,
            borderBottomEndRadius: 7,
            paddingHorizontal: 18,
            paddingVertical: 14,
            backgroundColor: colors.raised,
            gap: 8,
            marginTop: 22,
            marginBottom: 24,
          }}
        >
          {block.message.parts.map((part, i) =>
            part.type === "text" ? (
              <T key={i} selectable>
                {part.text}
              </T>
            ) : part.type === "image" ? (
              <Image
                key={i}
                source={{ uri: `data:${part.media_type};base64,${part.data}` }}
                accessibilityLabel="Attached image"
                style={{ width: 220, height: 170, borderRadius: 12 }}
                resizeMode="contain"
              />
            ) : (
              <View key={i} style={styles.line}>
                <Icon
                  name={
                    part.type === "file_mention"
                      ? "doc"
                      : part.type === "skill"
                        ? "sparkles"
                        : "paperclip"
                  }
                  size={15}
                />
                <T variant="caption">
                  {part.type === "attachment"
                    ? part.name
                    : part.type === "file_mention"
                      ? part.path
                      : part.type === "skill"
                        ? part.name
                        : (part.display_name ?? part.name)}
                </T>
              </View>
            ),
          )}
        </View>
      );
    case "assistant":
      return (
        <View style={{ paddingBottom: 18, gap: 10 }}>
          {!!block.thinking && (
            <>
              <Tap
                label={expanded ? "Hide reasoning" : "Show reasoning"}
                onPress={() => setExpanded(!expanded)}
                style={[styles.line, { gap: 7 }]}
              >
                <Icon name="sparkle" size={14} color={colors.muted} />
                <T variant="caption" tone="secondary">
                  {block.complete ? "Thought process" : "Thinking"}
                </T>
                <Icon
                  name={expanded ? "chevron.up" : "chevron.down"}
                  size={9}
                  color={colors.muted}
                />
              </Tap>
              {expanded && (
                <Animated.View
                  entering={FadeIn.duration(160)}
                  exiting={FadeOut.duration(120)}
                  style={{
                    paddingStart: 14,
                    borderStartWidth: 1,
                    borderColor: colors.line,
                  }}
                >
                  <T variant="caption" tone="secondary" selectable>
                    {block.thinking}
                  </T>
                </Animated.View>
              )}
            </>
          )}
          {!!block.text && (
            <StreamedMarkdown
              text={block.text}
              complete={block.complete}
              active={active}
            />
          )}
          {block.complete && !!block.text && (
            <View style={{ flexDirection: "row", gap: 0, marginStart: -12 }}>
              <IconButton
                name={copied ? "checkmark" : "doc.on.doc"}
                label={copied ? "Copied response" : "Copy response"}
                onPress={() => {
                  void Clipboard.setStringAsync(block.text).then(() =>
                    setCopied(true),
                  );
                }}
              />
              <IconButton
                name="square.and.arrow.up"
                label="Share response"
                onPress={() => void Share.share({ message: block.text })}
              />
            </View>
          )}
        </View>
      );
    case "tool":
      return (
        <View style={{ marginBottom: 5 }}>
          <Tap
            label={`${block.call.name}, ${block.complete ? (block.isError ? "failed" : "complete") : "working"}. ${expanded ? "Hide" : "Show"} details`}
            onPress={() => setExpanded(!expanded)}
            style={[styles.line, { gap: 10, paddingVertical: 6 }]}
          >
            <Icon
              name={
                block.isError
                  ? "exclamationmark.circle"
                  : block.complete
                    ? "checkmark"
                    : "circle.dotted"
              }
              size={14}
              color={block.isError ? colors.negative : colors.muted}
            />
            <T
              variant="caption"
              tone="secondary"
              style={{ flex: 1 }}
              numberOfLines={1}
            >
              {toolSummary(block)}
            </T>
            <Icon
              name={expanded ? "chevron.up" : "chevron.down"}
              size={9}
              color={colors.muted}
            />
          </Tap>
          {expanded && (
            <Animated.View entering={FadeIn.duration(160)}>
              <Code
                text={JSON.stringify(block.call.input, null, 2)}
                language={block.call.name}
              />
              <Code
                text={
                  typeof block.output === "string"
                    ? block.output
                    : block.output
                      ? JSON.stringify(block.output, null, 2)
                      : block.stream || "Waiting for output…"
                }
                language="Result"
              />
            </Animated.View>
          )}
        </View>
      );
    case "approval":
      return block.decision ? (
        <View style={[styles.line, { paddingVertical: 8 }]}>
          <Icon
            name={
              block.decision.decision === "deny"
                ? "xmark.circle"
                : "checkmark.circle"
            }
            size={14}
            color={colors.secondary}
          />
          <T variant="caption" tone="secondary">
            {block.decision.decision === "deny"
              ? "Request declined"
              : "Request approved"}
          </T>
        </View>
      ) : (
        <View style={{ marginVertical: 14 }}>
          <ApprovalPanel approval={block.approval} />
        </View>
      );
    case "notice":
      return (
        <T
          variant="caption"
          tone={block.level === "error" ? "negative" : "secondary"}
          style={{ paddingVertical: 12 }}
        >
          {block.text}
        </T>
      );
    case "runtime_task":
      return <TaskRow task={block.task} />;
    case "turn_end":
      return (
        <View style={{ marginTop: 8, marginBottom: 26, gap: 6 }}>
          {block.error && <T tone="negative">{block.error}</T>}
          <View style={styles.spread}>
            <T variant="caption" tone="muted">
              {grouped && block.stopReason === "completed"
                ? new Date(block.at).toLocaleTimeString([], {
                    hour: "numeric",
                    minute: "2-digit",
                  })
                : block.stopReason === "completed"
                  ? "Completed"
                  : block.stopReason === "interrupted"
                    ? "Stopped"
                    : block.stopReason === "error"
                      ? "Failed"
                      : "Turn limit reached"}
              {(!grouped || block.stopReason !== "completed") &&
                ` · ${Math.max(1, Math.round(block.durationMs / 1000))}s`}
              {block.costUsd != null ? ` · $${block.costUsd.toFixed(3)}` : ""}
            </T>
            <Tap
              label="Rewind to this checkpoint"
              onPress={() =>
                Alert.alert(
                  "Rewind this thread?",
                  "This restores the workspace and conversation to this checkpoint.",
                  [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Rewind thread",
                      style: "destructive",
                      onPress: () => {
                        void rpc("threads.revert", {
                          thread_id: threadId,
                          turn_id: block.turnId,
                        })
                          .then(() => loadThread(threadId))
                          .catch((e) =>
                            Alert.alert("Unable to rewind", errorText(e)),
                          );
                      },
                    },
                  ],
                )
              }
            >
              <Icon
                name="clock.arrow.circlepath"
                size={15}
                color={colors.muted}
              />
            </Tap>
          </View>
        </View>
      );
    case "reverted":
      return (
        <T variant="caption" tone="secondary">
          Restored checkpoint {block.commit.slice(0, 7)}
        </T>
      );
    case "image": {
      const env = activeEnvironment();
      const uri = env
        ? `${httpBase(env.url)}/threads/${encodeURIComponent(threadId)}/image?path=${encodeURIComponent(block.source)}`
        : "";
      return (
        <Image
          source={{
            uri,
            headers: { authorization: `Bearer ${env?.token ?? ""}` },
          }}
          accessibilityLabel="Image from agent response"
          style={{
            width: "100%",
            height: 240,
            borderRadius: 16,
            marginVertical: 12,
          }}
          resizeMode="contain"
        />
      );
    }
  }
});

const StreamedMarkdown = memo(function StreamedMarkdown({
  text,
  complete,
  active,
}: {
  text: string;
  complete: boolean;
  active: boolean;
}) {
  const shown = useStreamedText(text, complete, active);
  return <Markdown text={shown} />;
});
