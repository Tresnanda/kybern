import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Linking, View } from "react-native";
import { Alert } from "../ui/Alert";
import {
  MorphingMenu,
  type MenuOrigin,
} from "../components/liquid/MorphingMenu";
import type { Diff, GitStatus, Thread } from "../state/protocol";
import { activeEnvironment, errorText, refresh, rpc } from "../state/runtime";
import {
  ErrorBanner,
  Icon,
  IconButton,
  T,
  Tap,
  styles,
  type IconName,
} from "../ui/primitives";
import { useTheme } from "../ui/theme";

export function WorkspaceMenu({ thread }: { thread?: Thread | null }) {
  const { colors } = useTheme();
  const trigger = useRef<View>(null);
  const afterClose = useRef<(() => void) | null>(null);
  const [origin, setOrigin] = useState<MenuOrigin | null>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const closed = useCallback(() => {
    setOrigin(null);
    afterClose.current?.();
    afterClose.current = null;
  }, []);
  function show() {
    trigger.current?.measureInWindow((x, y, width, height) => {
      setOrigin({ x, y, width, height });
      setOpen(true);
    });
  }
  const [git, setGit] = useState<GitStatus>();
  const [diff, setDiff] = useState<Diff>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const threadId = thread?.id;
  async function reload() {
    if (!threadId) return;
    const [status, changes] = await Promise.all([
      rpc("git.status", { thread_id: threadId }),
      rpc("threads.diff", { thread_id: threadId }),
    ]);
    setGit(status);
    setDiff(changes);
  }
  useEffect(() => {
    if (open) {
      setError("");
      void reload().catch((e) => setError(errorText(e)));
    }
  }, [open, threadId]);
  const adds = diff?.files.reduce((n, f) => n + f.additions, 0);
  const dels = diff?.files.reduce((n, f) => n + f.deletions, 0);
  function navigate(tab: string) {
    afterClose.current = () =>
      router.push({ pathname: "/workspace", params: { threadId, tab } });
    close();
  }
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await reload();
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  function commit() {
    Alert.alert(
      "Commit changes?",
      "Commit all current workspace changes with a generated commit message.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Commit changes",
          onPress: () =>
            void run(() => rpc("git.commit", { thread_id: threadId! })),
        },
      ],
    );
  }
  function createPr() {
    Alert.alert(
      "Create pull request?",
      "Commit current changes, push this branch, and open a pull request on GitHub.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Create pull request",
          onPress: () =>
            void run(() =>
              rpc("github.pr.create", {
                thread_id: threadId!,
                commit_first: true,
              }),
            ),
        },
      ],
    );
  }
  const row = (
    title: string,
    icon: IconName,
    action: () => void,
    disabled = false,
    trailing?: React.ReactNode,
  ) => (
    <Tap
      key={title}
      label={title}
      disabled={disabled || busy}
      onPress={action}
      style={[
        styles.line,
        { gap: 9, paddingHorizontal: 10, paddingVertical: 4 },
      ]}
    >
      <Icon name={icon} size={17} />
      <T
        variant="label"
        numberOfLines={1}
        style={{ flex: 1, fontSize: 14, lineHeight: 20 }}
      >
        {title}
      </T>
      {trailing}
    </Tap>
  );
  const remote = git?.remote_url
    ?.replace(/^git@([^:]+):/, "https://$1/")
    .replace(/\.git$/, "");
  return (
    <>
      <View
        ref={trigger}
        collapsable={false}
        style={{
          borderRadius: 24,
          backgroundColor: colors.surface,
          boxShadow: "0 3px 14px #00000012",
          opacity: origin ? 0 : 1,
        }}
      >
        <IconButton name="ellipsis" label="Open thread menu" onPress={show} />
      </View>
      {origin && (
        <MorphingMenu
          origin={origin}
          open={open}
          onClose={close}
          onClosed={closed}
        >
          <View style={[styles.spread, { paddingStart: 12 }]}>
            <T variant="caption" tone="secondary">
              Environment
            </T>
            <IconButton
              name="xmark"
              label="Close thread menu"
              onPress={close}
            />
          </View>
          <ErrorBanner
            error={error}
            onRetry={() => void reload().catch((e) => setError(errorText(e)))}
          />
          {row(
            "Changes",
            "doc.badge.plus",
            () => navigate("Changes"),
            !diff,
            <View style={[styles.line, { gap: 5 }]}>
              <T variant="label" tone="positive">
                {adds == null ? "" : `+${adds}`}
              </T>
              <T variant="label" tone="negative">
                {dels == null ? "" : `−${dels}`}
              </T>
            </View>,
          )}
          {row(
            thread?.worktree
              ? "Worktree"
              : activeEnvironment()?.name || "Local",
            "laptopcomputer",
            () => navigate("Files"),
          )}
          {!!git?.branch &&
            row(
              git.branch,
              "arrow.triangle.branch",
              () => void Clipboard.setStringAsync(git.branch!),
              false,
              <T variant="caption" tone="secondary">
                {git.ahead ? `↑${git.ahead}` : ""}
                {git.behind ? ` ↓${git.behind}` : ""}
              </T>,
            )}
          {git?.is_git &&
            row(
              "Commit changes",
              "point.topleft.down.to.point.bottomright.curvepath",
              commit,
              !git.dirty_files,
            )}
          {!!remote && (
            <>
              <T
                variant="caption"
                tone="secondary"
                style={{
                  paddingHorizontal: 10,
                  paddingTop: 10,
                  paddingBottom: 4,
                }}
              >
                Repository
              </T>
              {row(
                remote.replace(/^https?:\/\/[^/]+\//, ""),
                "link",
                () => void Linking.openURL(remote),
              )}
            </>
          )}
          {git?.is_git && (
            <>
              <T
                variant="caption"
                tone="secondary"
                style={{
                  paddingHorizontal: 10,
                  paddingTop: 10,
                  paddingBottom: 4,
                }}
              >
                Pull request
              </T>
              {git.pull_request
                ? row(
                    `#${git.pull_request.number} ${git.pull_request.title}`,
                    "arrow.up.right",
                    () => void Linking.openURL(git.pull_request!.url),
                  )
                : row(
                    "Create pull request",
                    "arrow.triangle.pull",
                    createPr,
                    !remote,
                  )}
            </>
          )}
          <T
            variant="caption"
            tone="secondary"
            style={{ paddingHorizontal: 10, paddingTop: 10, paddingBottom: 4 }}
          >
            Thread
          </T>
          {row(
            thread?.pinned ? "Unpin thread" : "Pin thread",
            "pin",
            () =>
              void run(() =>
                rpc("threads.update", {
                  thread_id: threadId!,
                  pinned: !thread?.pinned,
                }),
              ),
          )}
          {row("Thread details", "slider.horizontal.3", () => navigate("More"))}
          {busy && (
            <T variant="caption" tone="secondary" style={{ padding: 12 }}>
              Updating workspace…
            </T>
          )}
        </MorphingMenu>
      )}
    </>
  );
}
export function WorkspacePill({
  threadId,
  activeTasks = 0,
  onJumpToLatest,
}: {
  threadId: string;
  activeTasks?: number;
  onJumpToLatest?: () => void;
}) {
  const { colors } = useTheme();
  const pill = {
    borderRadius: 24,
    backgroundColor: colors.surface,
    boxShadow: "0 3px 18px #00000018",
    paddingHorizontal: 14,
    gap: 7,
  };
  return (
    <View
      style={{
        alignSelf: "stretch",
        alignItems: "center",
        marginStart: 20,
        flexDirection: "row",
        marginEnd: 20,
        gap: 8,
      }}
    >
      {(
        [
          ["Files", "folder"],
          ["Terminal", "terminal"],
        ] as const
      ).map(([tab, icon]) => (
        <Tap
          key={tab}
          label={`Open ${tab.toLowerCase()}`}
          onPress={() =>
            router.push({ pathname: "/workspace", params: { threadId, tab } })
          }
          style={[styles.line, pill]}
        >
          <Icon name={icon} size={16} />
        </Tap>
      ))}
      <Tap
        label={`Open tasks and agents${activeTasks ? `, ${activeTasks} active` : ""}`}
        onPress={() =>
          router.push({ pathname: "/tasks", params: { threadId } })
        }
        style={[styles.line, pill]}
      >
        <Icon name="person.2" size={16} />
        {activeTasks > 0 && (
          <T variant="caption" tone="accent">
            {activeTasks}
          </T>
        )}
      </Tap>
      <View style={{ flex: 1 }} />
      {onJumpToLatest && (
        <Tap
          label="Jump to latest message"
          onPress={onJumpToLatest}
          style={[styles.line, pill]}
        >
          <Icon name="arrow.down" size={14} />
          <T variant="caption" numberOfLines={1}>
            Latest
          </T>
        </Tap>
      )}
    </View>
  );
}
