// One thread row for the phone Threads screen and the iPad sidebar: the kit's
// ListRow with the thread's anatomy (status or agent mark, title, project ·
// agent · state, time) and its attention (a waiting request badge, an unread
// dot), plus nested delegated/subagent children and their disclosure.
import { threadAttention } from "../../../../packages/kybern-client/src/threadAttention";
import { childState, delegationRoleLabel } from "../../../../packages/kybern-client/src/delegations";
import { router } from "expo-router";
import { memo } from "react";
import { View } from "react-native";
import { attentionSignals, dismissAttention, markRead, markUnread, useListState } from "../state/listState";
import { count } from "../state/format";
import { PROVIDER_DISPLAY_NAME, type Thread, type ThreadActivitySummary } from "../state/protocol";
import type { ThreadMachine } from "../state/machineLists";
import { errorText, mutate, refresh, threadHasActivity, useApp } from "../state/runtime";
import type { StatusPhase } from "../state/status";
import { relativeTime, type ThreadRow } from "../state/threadList";
import { DisclosureRow, ListRow, rowInset, type SwipeAction } from "../ui/List";
import type { MenuItem } from "../ui/menuModel";
import { T } from "../ui/primitives";
import { ProviderMark } from "../ui/ProviderMark";
import { StatusGlyph } from "../ui/TaskGlyphs";
import { radius, space, useTheme } from "../ui/theme";
import { showToast } from "../ui/Toast";
import { MachineGlyph } from "./MachineGlyph";
import { originLabel } from "../../../../packages/kybern-client/src/forkMachine";
import { threadMenuItems } from "./threadActions";

const untitled = (thread: Thread) => thread.title.trim() || "Untitled thread";

/** "Needs input" / "Pending approval": the one coloured word in a row. */
function AttentionBadge({ text }: { text: string }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        paddingHorizontal: space.sm,
        paddingVertical: space["2xs"],
        borderRadius: radius.full,
        backgroundColor: colors.warningSoft,
      }}
    >
      <T variant="caption" tone="warning" numberOfLines={1} style={{ fontWeight: "600" }}>
        {text}
      </T>
    </View>
  );
}

/** The agent's mark, with an accent dot when a finished turn hasn't been seen. */
function AgentMark({ thread, unread }: { thread: Thread; unread: boolean }) {
  const { colors } = useTheme();
  return (
    <View>
      <ProviderMark kind={thread.provider.kind} size={20} />
      {unread ? (
        <View
          accessible={false}
          style={{
            position: "absolute",
            top: -3,
            end: -4,
            width: 10,
            height: 10,
            borderRadius: 5,
            borderWidth: 1.5,
            borderColor: colors.background,
            backgroundColor: colors.accent,
          }}
        />
      ) : null}
    </View>
  );
}

export type ThreadRowContext = {
  /** Phone list: project shown in the subtitle, swipe actions. Sidebar: grouped by project already. */
  variant: "list" | "sidebar";
  activeId?: string;
  projectName: (projectId: string) => string;
  /** Where a thread lives, with more than one machine; its glyph and greyed state follow. */
  machine?: (threadId: string) => ThreadMachine | undefined;
  /** Live work of every machine's threads. Without it the computer's own activity is used. */
  activity?: readonly ThreadActivitySummary[];
  onToggleChildren: (threadId: string, open: boolean) => void;
  onError?: (message: string) => void;
};

function open(thread: Thread, variant: ThreadRowContext["variant"]) {
  const target = { pathname: "/thread/[id]" as const, params: { id: thread.id } };
  if (variant === "sidebar") router.navigate(target);
  else router.push(target);
}

/** A row of `threadRows()`: a top-level thread or a nested child, then its disclosure. */
export const ThreadListRow = memo(ThreadListRowView, sameRow);

/**
 * `threadRows()` makes fresh row objects on every recompute, so a plain memo never
 * hit and a fold or "Show more" re-rendered every visible row. Compare what the
 * row shows instead.
 */
function sameRow(a: { row: ThreadRow; ctx: ThreadRowContext }, b: { row: ThreadRow; ctx: ThreadRowContext }) {
  return (
    a.ctx === b.ctx &&
    a.row.thread === b.row.thread &&
    a.row.depth === b.row.depth &&
    a.row.childCount === b.row.childCount &&
    a.row.open === b.row.open &&
    a.row.child === b.row.child
  );
}

function ThreadListRowView({
  row,
  ctx,
}: {
  row: ThreadRow;
  ctx: ThreadRowContext;
}) {
  const app = useApp();
  const list = useListState();
  const { thread, depth, childCount, open: childrenOpen, child } = row;
  const indent = Math.min(depth, 2) * space.lg;
  const home = ctx.machine?.(thread.id);
  const agent = PROVIDER_DISPLAY_NAME[thread.provider.kind] ?? thread.provider.kind;
  const fail = (e: unknown) => ctx.onError?.(errorText(e));

  let leading;
  let subtitle: string;
  let badge: string | null = null;
  let label: string;
  const menu: MenuItem[] = [];
  let swipe: { leading?: SwipeAction[]; trailing?: SwipeAction[] } | undefined;

  if (child) {
    const pending = list.pending[thread.id]?.own ?? null;
    const state = childState(thread, pending);
    leading = (
      <StatusGlyph phase={state.phase as StatusPhase} animated={state.phase === "working" || state.phase === "waiting"} />
    );
    const kind = thread.delegation ? delegationRoleLabel(thread.delegation.role) : "Subagent";
    subtitle = `${kind} · ${state.word}`;
    label = `${untitled(thread)}, ${subtitle}`;
  } else {
    const attention = threadAttention(thread, attentionSignals(list));
    badge = attention.badge;
    const running = threadHasActivity(thread, ctx.activity ?? app.activity);
    const waiting = attention.kind === "blocked" || thread.status === "awaiting-approval";
    const failed = attention.kind === "failed";
    const word = waiting ? null : running ? "Working" : failed ? "Failed" : null;
    leading = waiting ? (
      <StatusGlyph phase="waiting" animated />
    ) : running ? (
      <StatusGlyph phase="working" animated />
    ) : failed ? (
      <StatusGlyph phase="failed" />
    ) : (
      <AgentMark thread={thread} unread={attention.unread} />
    );
    const parts = ctx.variant === "list" ? [ctx.projectName(thread.project_id), agent] : [agent];
    // A thread another machine started by a fork or a delegation says where it came from.
    const from = originLabel(thread);
    if (from) parts.push(from);
    if (home?.offline) parts.push("Offline");
    if (word) parts.push(word);
    subtitle = parts.join(" · ");
    label = [untitled(thread), subtitle, home?.showGlyph ? `On ${home.name}` : "", badge, attention.unread ? "Unread" : "", thread.pinned ? "Pinned" : ""]
      .filter(Boolean)
      .join(", ");

    menu.push(...threadMenuItems(thread, { refresh: () => refresh(home?.machineId), onError: ctx.onError }));
    if (thread.status !== "archived")
      menu.splice(1, 0, attention.unread
        ? { title: "Mark as read", icon: "checkmark.circle", onPress: () => markRead(thread.id) }
        : { title: "Mark as unread", icon: "circle", onPress: () => markUnread(thread.id) });
    if (attention.kind === "blocked" || attention.kind === "failed")
      menu.splice(2, 0, { title: "Dismiss", icon: "xmark.circle", onPress: () => dismissAttention([thread]) });

    if (ctx.variant === "list" && thread.status !== "archived")
      swipe = {
        leading: [
          {
            title: thread.pinned ? "Unpin" : "Pin",
            icon: "pin",
            tone: "accent",
            full: true,
            onPress: () => {
              void mutate("threads.update", { thread_id: thread.id, pinned: !thread.pinned }).catch(fail);
            },
          },
        ],
        trailing: [
          {
            title: "Archive",
            icon: "archivebox",
            tone: "neutral",
            full: true,
            onPress: () => {
              void mutate("threads.archive", { thread_id: thread.id })
                .then(() => showToast("Thread archived"))
                .catch(fail);
            },
          },
        ],
      };
  }

  return (
    <View style={{ paddingStart: indent }}>
      <ListRow
        title={untitled(thread)}
        subtitle={subtitle}
        subtitleLines={1}
        leading={leading}
        meta={child ? undefined : relativeTime(thread.updated_at)}
        trailing={
          badge || home?.showGlyph ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              {badge ? <AttentionBadge text={badge} /> : null}
              {home?.showGlyph ? <MachineGlyph glyph={home.glyph} /> : null}
            </View>
          ) : undefined
        }
        dimmed={home?.offline}
        selected={ctx.activeId === thread.id}
        label={label}
        onPress={() => open(thread, ctx.variant)}
        menu={menu.length ? menu : undefined}
        menuTitle={untitled(thread)}
        swipe={swipe}
      />
      {childCount > 0 ? (
        <View style={{ minHeight: 36, justifyContent: "center" }}>
          <DisclosureRow
            title={count(childCount, "helper")}
            open={childrenOpen}
            indent={rowInset(true) - space.lg}
            onToggle={() => ctx.onToggleChildren(thread.id, !childrenOpen)}
          />
        </View>
      ) : null}
    </View>
  );
}
