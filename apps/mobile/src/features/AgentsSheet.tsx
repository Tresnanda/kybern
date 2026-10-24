// The Agents sheet: everything a thread started, in one place (ux-thread H2, H6, H9).
//
//   AgentsList          Agents | Processes, running first, status glyph + shared words,
//                       cleaned mono commands. Rendered by the `/agents` sheet, the
//                       full-screen `/tasks` route and the iPad inspector.
//   AgentsCapsule       the bottom-bar entry point ("15 agents · 2 running").
//   RunningProcessesRow a compact transcript row ("3 processes running ›") that opens
//                       the sheet on Processes, so a running thread never lists every
//                       process at once. The transcript lane places it.
//   openAgents          opens the sheet from anywhere.
import { router } from "expo-router";
import { Fragment, useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { agentsModel, type AgentRow, type AgentsModel } from "../state/agents";
import type { RuntimeTask, Thread } from "../state/protocol";
import { count } from "../state/format";
import { useChildThreads } from "./ChildThreads";
import { InsetGroup, ListRow, SectionHeader } from "../ui/List";
import { Empty, Icon, T, Tap } from "../ui/primitives";
import { ProviderMark } from "../ui/ProviderMark";
import { Segmented } from "../ui/Segmented";
import { StatusGlyph } from "../ui/TaskGlyphs";
import { radius, space, useTheme } from "../ui/theme";

export type AgentsSegment = "agents" | "processes";

/** Opens the Agents sheet for a thread, optionally on one segment. */
export function openAgents(threadId: string, segment?: AgentsSegment) {
  router.push({ pathname: "/agents", params: { threadId, ...(segment ? { segment } : null) } });
}

/** A clock for live elapsed text: ticks once a second only while something runs. */
function useNow(live: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  return now;
}

/**
 * The model for a thread's agents and processes. `live` ticks elapsed times;
 * leave it off where only counts are shown (the capsule).
 */
export function useAgents(
  thread: Thread | null | undefined,
  tasks: readonly RuntimeTask[],
  { active = true, live = false } = {},
): AgentsModel & { children: Thread[] } {
  const children = useChildThreads(thread, active);
  const running = tasks.some((task) => ["pending", "running", "waiting", "stopping"].includes(task.status));
  const now = useNow(live && active && (running || children.length > 0));
  return useMemo(() => ({ ...agentsModel(children, tasks, now), children }), [children, tasks, now]);
}

function Row({ row, onOpen }: { row: AgentRow; onOpen: (row: AgentRow) => void }) {
  return (
    <ListRow
      title={row.title}
      mono={row.mono}
      subtitle={row.subtitle}
      subtitleLines={1}
      leading={
        <View style={{ width: 28, alignItems: "center", justifyContent: "center" }}>
          <StatusGlyph phase={row.phase} size={18} animated={row.active} />
          {row.provider ? (
            <View style={{ position: "absolute", end: -4, bottom: -4 }}>
              <ProviderMark kind={row.provider} size={11} />
            </View>
          ) : null}
        </View>
      }
      chevron
      label={`Open ${row.title}. ${row.subtitle}`}
      onPress={() => onOpen(row)}
    />
  );
}

/**
 * Agents | Processes with Running and Finished groups. `onOpen` defaults to
 * navigating; the sheet passes one that closes itself first.
 */
export function AgentsList({
  threadId,
  model,
  segment,
  onSegment,
  onOpen,
}: {
  threadId: string;
  model: AgentsModel;
  segment: AgentsSegment;
  onSegment: (segment: AgentsSegment) => void;
  onOpen?: (row: AgentRow) => void;
}) {
  const open =
    onOpen ??
    ((row: AgentRow) => {
      if ("thread" in row.target) router.push({ pathname: "/thread/[id]", params: { id: row.target.thread } });
      else router.push({ pathname: "/tasks", params: { threadId, taskId: row.target.task } });
    });
  const rows = segment === "agents" ? model.agents : model.processes;
  const running = rows.filter((row) => row.active);
  const finished = rows.filter((row) => !row.active);
  const groups = [
    { title: "Running", rows: running },
    { title: "Finished", rows: finished },
  ].filter((group) => group.rows.length);
  return (
    <View>
      <Segmented
        label="Show"
        value={segment}
        onChange={onSegment}
        options={[
          { value: "agents", label: `Agents · ${model.agents.length}` },
          { value: "processes", label: `Processes · ${model.processes.length}` },
        ]}
      />
      {groups.map((group, index) => (
        <Fragment key={group.title}>
          <SectionHeader title={group.title} count={group.rows.length} inset />
          <InsetGroup>
            {group.rows.map((row) => (
              <Row key={row.key} row={row} onOpen={open} />
            ))}
          </InsetGroup>
        </Fragment>
      ))}
      {!rows.length && (
        <Empty
          icon={segment === "agents" ? "person.2" : "terminal"}
          title={segment === "agents" ? "No agents yet" : "No processes yet"}
          detail={
            segment === "agents"
              ? "Agents this thread delegates to or starts appear here."
              : "Commands the agent runs in the background appear here."
          }
        />
      )}
    </View>
  );
}

/** The bottom-bar entry point. 36 pt, sits on the bar's material. */
export function AgentsCapsule({ label, running, onPress }: { label: string; running: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Tap
      label={`${label}. Open agents and processes`}
      onPress={onPress}
      hitSlop={{ top: 4, bottom: 4 }}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        height: 36,
        minHeight: 36,
        paddingHorizontal: space.md,
        borderRadius: radius.full,
        backgroundColor: colors.raised,
      }}
    >
      {running ? (
        <StatusGlyph phase="working" size={15} animated />
      ) : (
        <Icon name="person.2" size={16} color={colors.secondary} />
      )}
      <T variant="label" numberOfLines={1} style={{ fontVariant: ["tabular-nums"] }}>
        {label}
      </T>
    </Tap>
  );
}

/**
 * One row standing in for a running thread's live processes ("3 processes
 * running ›"). Finished processes fold into the turn's step group; this row
 * opens the sheet on Processes. Renders nothing when none run.
 */
export function RunningProcessesRow({ threadId, tasks }: { threadId: string; tasks: readonly RuntimeTask[] }) {
  const { colors } = useTheme();
  const running = tasks.filter(
    (task) => task.kind !== "agent" && ["pending", "running", "waiting", "stopping"].includes(task.status),
  ).length;
  if (!running) return null;
  return (
    <Tap
      label={`${count(running, "process", "processes")} running. Open processes`}
      feedback="highlight"
      onPress={() => openAgents(threadId, "processes")}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        minHeight: 36,
        paddingHorizontal: space.sm,
        borderRadius: radius.sm,
        alignSelf: "flex-start",
      }}
    >
      <StatusGlyph phase="working" size={14} animated />
      <T variant="footnote" tone="secondary" style={{ fontWeight: "500" }}>
        {count(running, "process", "processes")} running
      </T>
      <Icon name="chevron.right" size={12} color={colors.muted} />
    </Tap>
  );
}
