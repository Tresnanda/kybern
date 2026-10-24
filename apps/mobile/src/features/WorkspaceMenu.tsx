// The thread's "…" menu (ux-thread H5/M7, user decision: it stays a menu). At most
// eight rows: a summary of where the thread works (branch · computer · +n −m), the git
// actions, Files and Terminal, a Thread ▸ submenu for the rarer pages, and worktree
// cleanup. Every action says what it did with a toast. Themed menu with a scrim on
// both platforms (an in-page "…" has no native tap menu without a bar button).
import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Linking, View } from "react-native";
import { groupFilesByRepo, includedMembers, prButtonLabel } from "../../../../packages/kybern-client/src/groups";
import { shortBranch } from "../../../../packages/kybern-client/src/delegations";
import { useMenuSurface, type MenuItem } from "../ui/ActionMenu";
import { measureTrigger } from "../ui/measure";
import { openAgents } from "./AgentsSheet";
import { Alert, confirm } from "../ui/Alert";
import { showToast } from "../ui/Toast";
import { IconButton } from "../ui/primitives";
import type { Diff, GitStatus, Thread } from "../state/protocol";
import { activeEnvironment, errorText, refresh, rpc, useApp } from "../state/runtime";
import { type InspectorTab, useLayout } from "../state/layout";
import { prPlan, repoPullRows } from "../state/groups";

// Tabs that have a live inspector pane on wide layouts, so the menu reveals them
// in the dock instead of pushing a full-screen route.
const INSPECTOR_TAB: Record<string, InspectorTab> = {
  Changes: "changes",
  Files: "files",
  Terminal: "terminal",
  Preview: "preview",
  Notes: "notes",
};

const grouped = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** `+14,878 −539`; the minus is U+2212 like every diffstat. */
export function diffLabel(adds: number, dels: number) {
  return `+${grouped(adds)} −${grouped(dels)}`;
}

/** Git state behind the menu. Reloads when the thread settles, so the menu opens instantly. */
function useWorkspaceState(thread?: Thread | null) {
  const app = useApp();
  const [git, setGit] = useState<GitStatus>();
  const [diff, setDiff] = useState<Diff>();
  const threadId = thread?.id;
  const settled = thread?.status !== "running" && thread?.status !== "awaiting-approval";
  const reload = useCallback(async () => {
    if (!threadId) return;
    const [status, changes] = await Promise.all([
      rpc("git.status", { thread_id: threadId }),
      rpc("threads.diff", { thread_id: threadId }),
    ]);
    setGit(status);
    setDiff(changes);
  }, [threadId]);
  useEffect(() => {
    setGit(undefined);
    setDiff(undefined);
  }, [threadId]);
  useEffect(() => {
    if (app.status === "open" && settled) void reload().catch(() => {});
  }, [reload, settled, app.status]);
  return { git, diff, reload };
}

export function WorkspaceMenu({ thread }: { thread?: Thread | null }) {
  const { regular, openInspector } = useLayout();
  const { git, diff, reload } = useWorkspaceState(thread);
  const menu = useMenuSurface();
  const anchor = useRef<View>(null);
  const threadId = thread?.id;

  function navigate(tab: string) {
    const inspectorTab = INSPECTOR_TAB[tab];
    if (regular && inspectorTab) openInspector(inspectorTab);
    else if (tab === "Preview") router.push({ pathname: "/preview", params: { threadId } });
    else router.push({ pathname: "/workspace", params: { threadId, tab } });
  }
  async function run(action: () => Promise<unknown>, done: string) {
    try {
      await action();
      showToast(done);
      await Promise.all([reload(), refresh()]);
    } catch (e) {
      showToast(errorText(e));
    }
  }

  const adds = diff?.files.reduce((n, f) => n + f.additions, 0) ?? 0;
  const dels = diff?.files.reduce((n, f) => n + f.deletions, 0) ?? 0;
  const changes = diff ? (diff.files.length ? diffLabel(adds, dels) : "No changes") : undefined;
  const repos = (git?.repos ?? []).filter((repo) => repo.included);
  const group = repos.length > 0;
  const changed = new Set(
    diff && thread?.members?.length
      ? groupFilesByRepo(diff, includedMembers(thread.members)).filter((g) => g.files.length).map((g) => g.repo.path)
      : (diff?.repos ?? []).filter((repo) => repo.files > 0).map((repo) => repo.repo),
  );
  const pulls = repoPullRows(repos);
  const plan = prPlan(repos, changed);
  const remote = git?.remote_url?.replace(/^git@([^:]+):/, "https://$1/").replace(/\.git$/, "");
  const computer = thread?.worktree ? "Worktree" : activeEnvironment()?.name || "Local";
  const branch = group ? null : (git?.branch ?? thread?.worktree?.branch ?? null);
  const dirty = group ? repos.some((repo) => repo.dirty_files > 0) : !!git?.dirty_files;

  function commit() {
    confirm({
      title: "Commit changes?",
      message: "Commits every current change in this workspace with a generated message.",
      confirm: "Commit",
      destructive: false,
      onConfirm: () => void run(() => rpc("git.commit", { thread_id: threadId! }), "Changes committed"),
    });
  }
  function createPr() {
    confirm({
      title: "Create pull request?",
      message: "Commits current changes, pushes this branch and opens a pull request on GitHub.",
      confirm: "Create",
      destructive: false,
      onConfirm: () =>
        void (async () => {
          try {
            const pr = await rpc("github.pr.create", { thread_id: threadId!, commit_first: true });
            showToast(`Opened pull request #${pr.number}`, { title: "View", onPress: () => void Linking.openURL(pr.url) });
            await Promise.all([reload(), refresh()]);
          } catch (e) {
            showToast(errorText(e));
          }
        })(),
    });
  }
  function createGroupPrs(count: number) {
    confirm({
      title: `${prButtonLabel(count)}?`,
      message: "Commits current changes, pushes each repository's branch and opens a linked pull request in each.",
      confirm: "Create",
      destructive: false,
      onConfirm: () =>
        void run(() => rpc("github.pr.create_group", { thread_id: threadId!, commit_first: true }), "Pull requests opened"),
    });
  }
  async function removeWorktree() {
    try {
      const info = await rpc("threads.worktree.inspect", { thread_id: threadId! });
      if (!info.exists) {
        showToast("This worktree was already removed");
        return;
      }
      if (!info.eligible) {
        Alert.alert("This worktree can't be removed yet", info.blockers.join("\n") || "Commit or discard its changes first.");
        return;
      }
      confirm({
        title: "Remove this worktree?",
        message: `Deletes ${info.path}.${info.merged ? ` Its branch ${info.branch} is merged and is deleted too.` : ` The branch ${info.branch} stays.`}`,
        confirm: "Remove",
        onConfirm: () =>
          void run(
            () => rpc("threads.worktree.remove", { thread_id: threadId!, delete_branch: info.merged }),
            "Worktree removed",
          ),
      });
    } catch (e) {
      showToast(errorText(e));
    }
  }

  const pullItems: MenuItem[] = group
    ? [
        {
          title: "Pull requests",
          icon: "arrow.triangle.pull",
          disabled: !pulls.length && !plan.create.length,
          children: [
            ...pulls.map((pull) => ({
              title: `${pull.name} #${pull.pullRequest.number}`,
              subtitle: pull.pullRequest.title,
              icon: "arrow.up.right" as const,
              onPress: () => void Linking.openURL(pull.pullRequest.url),
            })),
            ...(plan.create.length
              ? [{ title: `${prButtonLabel(plan.create.length)}…`, icon: "arrow.triangle.pull" as const, onPress: () => createGroupPrs(plan.create.length) }]
              : []),
          ],
        },
      ]
    : git?.is_git
      ? [
          git.pull_request
            ? {
                title: `Pull request #${git.pull_request.number}`,
                subtitle: git.pull_request.title,
                icon: "arrow.triangle.pull",
                onPress: () =>
                  thread?.project_id
                    ? router.push({ pathname: "/pull", params: { projectId: thread.project_id, number: String(git.pull_request!.number) } })
                    : void Linking.openURL(git.pull_request!.url),
              }
            : { title: "Create pull request…", icon: "arrow.triangle.pull", disabled: !remote, onPress: createPr },
        ]
      : [];

  const items: MenuItem[] = [
    {
      title: branch ? shortBranch(branch) : computer,
      subtitle: branch ? computer : undefined,
      icon: branch ? "arrow.triangle.branch" : "laptopcomputer",
      onPress: branch
        ? () => {
            void Clipboard.setStringAsync(branch);
            showToast("Branch name copied");
          }
        : () => navigate("Files"),
    },
    { title: "Changes", subtitle: changes, icon: "doc.badge.plus", onPress: () => navigate("Changes") },
    ...((git?.is_git || group)
      ? [{ title: "Commit changes…", icon: "point.topleft.down.to.point.bottomright.curvepath" as const, disabled: !dirty, onPress: commit }]
      : []),
    ...pullItems,
    { title: "Files", icon: "folder", onPress: () => navigate("Files") },
    { title: "Terminal", icon: "terminal", onPress: () => navigate("Terminal") },
    {
      title: "Thread",
      icon: "slider.horizontal.3",
      children: [
        {
          title: thread?.pinned ? "Unpin" : "Pin",
          icon: "pin",
          onPress: () =>
            void run(
              () => rpc("threads.update", { thread_id: threadId!, pinned: !thread?.pinned }),
              thread?.pinned ? "Thread unpinned" : "Thread pinned",
            ),
        },
        { title: "Details", icon: "slider.horizontal.3", onPress: () => navigate("More") },
        { title: "Agents", subtitle: "Delegated agents and processes", icon: "person.2", onPress: () => openAgents(threadId!, "agents") },
        { title: "Preview", subtitle: "Dev servers and pages", icon: "globe", onPress: () => navigate("Preview") },
        { title: "Artifacts", icon: "doc", onPress: () => navigate("Artifacts") },
        { title: "Notes", icon: "square.and.pencil", onPress: () => navigate("Notes") },
        {
          title: "Connectors and plugins",
          icon: "puzzlepiece.extension",
          onPress: () => router.push({ pathname: "/integrations", params: { threadId } }),
        },
        ...(!group && remote
          ? [
              {
                title: "Open repository",
                subtitle: remote.replace(/^https?:\/\/[^/]+\//, ""),
                icon: "link" as const,
                onPress: () => void Linking.openURL(remote),
              },
            ]
          : []),
      ],
    },
    ...(thread?.worktree && !thread.delegation
      ? [{ title: "Remove worktree…", icon: "trash" as const, destructive: true, onPress: () => void removeWorktree() }]
      : []),
  ];

  return (
    <>
      <View ref={anchor} collapsable={false}>
        <IconButton
          name="ellipsis"
          label="Thread actions"
          disabled={!thread}
          onPress={() => {
            void reload().catch(() => {});
            measureTrigger(anchor.current, (origin) => menu.show({ items, origin, sourceIcon: "ellipsis" }));
          }}
        />
      </View>
      {menu.element}
    </>
  );
}
