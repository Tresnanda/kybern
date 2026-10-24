// "Edited 3 files +42 −7" under a finished turn that changed files: the files with their counts, a
// tap opens one, and the newest turn offers Undo (rewind the workspace and conversation to before it).
import { router } from "expo-router";
import { memo, useCallback, useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import type { Diff, FileChange } from "../state/protocol";
import { count } from "../state/format";
import { errorText, getState, loadThread, rpc, useThreadValue } from "../state/runtime";
import type { ThreadState } from "../state/transcript";
import { confirm } from "../ui/Alert";
import { Button, Icon, T, Tap } from "../ui/primitives";
import { showToast } from "../ui/Toast";
import { radius, space, useTheme } from "../ui/theme";

const diffs = new Map<string, Diff | null>();
const VISIBLE = 5;

const STATUS: Record<string, { letter: string; tone: "positive" | "negative" | "warning" | "secondary" }> = {
  added: { letter: "A", tone: "positive" },
  deleted: { letter: "D", tone: "negative" },
  renamed: { letter: "R", tone: "secondary" },
  modified: { letter: "M", tone: "warning" },
};

/** The newest turn of an idle thread can be undone; older ones rewind from the answer's menu. */
function useCanUndo(threadId: string, turnId: string) {
  const select = useCallback(
    (snapshot: ThreadState) =>
      snapshot.blocks.at(-1)?.turnId === turnId &&
      snapshot.thread?.status !== "running" &&
      snapshot.thread?.status !== "awaiting-approval",
    [turnId],
  );
  return useThreadValue(threadId, select);
}

export async function rewindTurn(threadId: string, turnId: string) {
  try {
    await rpc("threads.revert", { thread_id: threadId, turn_id: turnId });
    for (const key of [...diffs.keys()]) if (key.startsWith(`${threadId}:`)) diffs.delete(key);
    await loadThread(threadId);
    showToast("Rewound to before this turn");
  } catch (e) {
    showToast(errorText(e) || "Unable to rewind. Try again.");
  }
}

export function confirmRewind(threadId: string, turnId: string, undo = false) {
  confirm({
    title: undo ? "Undo this turn?" : "Rewind to before this turn?",
    message: "This restores the workspace and the conversation to how they were before this message. Later turns are undone too.",
    confirm: undo ? "Undo turn" : "Rewind",
    onConfirm: () => void rewindTurn(threadId, turnId),
  });
}

export const EditedFilesCard = memo(function EditedFilesCard({ threadId, turnId }: { threadId: string; turnId: string }) {
  const { colors } = useTheme();
  const key = `${threadId}:${turnId}`;
  const [diff, setDiff] = useState<Diff | null | undefined>(() => diffs.get(key));
  const [open, setOpen] = useState(true);
  const [all, setAll] = useState(false);
  const canUndo = useCanUndo(threadId, turnId);
  useEffect(() => {
    if (diffs.has(key)) return setDiff(diffs.get(key));
    let alive = true;
    rpc("threads.diff", { thread_id: threadId, turn_id: turnId, include_patch: false })
      .then((result) => {
        diffs.set(key, result);
        if (diffs.size > 200) diffs.delete(diffs.keys().next().value!);
        if (alive) setDiff(result);
      })
      .catch(() => {
        // No git, or the checkpoint is gone: no card.
        diffs.set(key, null);
        if (alive) setDiff(null);
      });
    return () => {
      alive = false;
    };
  }, [key, threadId, turnId]);
  if (!diff || !diff.files.length) return null;
  const adds = diff.files.reduce((n, file) => n + file.additions, 0);
  const dels = diff.files.reduce((n, file) => n + file.deletions, 0);
  const files = all ? diff.files : diff.files.slice(0, VISIBLE);
  const openFile = (file: FileChange) => {
    const projectId = getState().threads.find((thread) => thread.id === threadId)?.project_id;
    router.push({ pathname: "/file", params: { threadId, projectId, path: file.path, scope: "thread" } });
  };
  return (
    <View
      style={{
        borderRadius: radius.md,
        borderCurve: "continuous",
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.line,
        backgroundColor: colors.card,
        overflow: "hidden",
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingStart: space.md, paddingEnd: space.xs, minHeight: 44 }}>
        <Tap
          label={`${open ? "Hide" : "Show"} edited files. ${count(diff.files.length, "file")} edited, ${adds} lines added, ${dels} removed`}
          expanded={open}
          onPress={() => setOpen(!open)}
          style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: space.sm }}
        >
          <T variant="subhead" style={{ fontWeight: "500" }} numberOfLines={1}>
            {`Edited ${count(diff.files.length, "file")}`}
          </T>
          <T variant="footnote" tone="positive" style={{ fontVariant: ["tabular-nums"] }}>{`+${adds}`}</T>
          <T variant="footnote" tone="negative" style={{ fontVariant: ["tabular-nums"] }}>{`−${dels}`}</T>
          <Icon name={open ? "chevron.up" : "chevron.down"} size={12} color={colors.muted} />
        </Tap>
        {canUndo && (
          <Button size="medium" role="plain" icon="arrow.uturn.backward" onPress={() => confirmRewind(threadId, turnId, true)}>
            Undo
          </Button>
        )}
      </View>
      {open && (
        <Animated.View entering={FadeIn.duration(160)}>
          {files.map((file) => {
            const status = STATUS[file.status] ?? STATUS.modified!;
            const slash = file.path.lastIndexOf("/");
            return (
              <Tap
                key={file.path}
                label={`Open ${file.path}, ${file.status}`}
                feedback="highlight"
                onPress={() => openFile(file)}
                style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.md, minHeight: 40, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.line }}
              >
                <T variant="code" tone={status.tone} style={{ width: 14, fontWeight: "600" }}>
                  {status.letter}
                </T>
                <T variant="code" numberOfLines={1} style={{ flexShrink: 0, maxWidth: "60%" }} ellipsizeMode="middle">
                  {file.path.slice(slash + 1)}
                </T>
                <T variant="code" tone="muted" numberOfLines={1} ellipsizeMode="middle" style={{ flex: 1 }}>
                  {slash > 0 ? file.path.slice(0, slash) : ""}
                </T>
                {!file.binary && (
                  <T variant="footnote" tone="muted" style={{ fontVariant: ["tabular-nums"] }}>
                    {`+${file.additions} −${file.deletions}`}
                  </T>
                )}
              </Tap>
            );
          })}
          {diff.files.length > VISIBLE && (
            <Tap
              label={all ? "Show fewer files" : `Show ${count(diff.files.length - VISIBLE, "more file")}`}
              onPress={() => setAll(!all)}
              feedback="highlight"
              style={{ paddingHorizontal: space.md, minHeight: 40, justifyContent: "center", borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.line }}
            >
              <T variant="footnote" tone="accent">
                {all ? "Show fewer" : `Show ${count(diff.files.length - VISIBLE, "more file")}`}
              </T>
            </Tap>
          )}
        </Animated.View>
      )}
    </View>
  );
});
