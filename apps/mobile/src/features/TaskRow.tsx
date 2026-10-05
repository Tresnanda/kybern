import * as Haptics from "expo-haptics";
import { memo, useEffect, useState } from "react";
import { View } from "react-native";
import type { TaskItem } from "../state/protocol";
import {
  PRIORITY_LABEL,
  STATUS_LABEL,
  ageLabel,
  diffLabel,
  isLiveRun,
  latestRun,
  runDuration,
  shortActivity,
  shortDuration,
  taskTitle,
} from "../state/tasksModel";
import { ProviderMark } from "../ui/ProviderMark";
import { T, Tap } from "../ui/primitives";
import { PriorityGlyph, ProjectDot, StatusGlyph } from "../ui/TaskGlyphs";
import { useTheme } from "../ui/theme";
import { openTask, taskMenu } from "./taskActions";

/** A clock for elapsed times and ages; ticks once a minute while mounted. */
export function useMinuteClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * One task: status glyph, title, then a quiet line with priority, key and either
 * what the agent is doing, the run's diff, or the project. Age sits on the right.
 */
export const TaskRow = memo(function TaskRow({
  task,
  projectName,
  showProject,
  now,
}: {
  task: TaskItem;
  projectName?: string;
  showProject: boolean;
  now: number;
}) {
  const { colors } = useTheme();
  const run = latestRun(task);
  const live = task.status === "running" && isLiveRun(run);
  const review = task.status === "needs_review" && run;
  let detail = "";
  if (live && run)
    detail =
      run.state === "waiting"
        ? "Waiting for you"
        : [run.activity ? shortActivity(run.activity) : "Working", shortDuration(runDuration(run, now))].join(" · ");
  else if (review && run) detail = diffLabel(run.diff) || "Ready for review";
  const where = showProject ? (task.project_id ? (projectName ?? "Project") : "Global") : "";
  const label = [
    task.key,
    taskTitle(task),
    STATUS_LABEL[task.status],
    task.priority ? `${PRIORITY_LABEL[task.priority]} priority` : "",
    detail,
    where,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <Tap
      label={label}
      static
      onPress={() => openTask(task.id)}
      onLongPress={() => {
        void Haptics.selectionAsync();
        taskMenu(task);
      }}
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 12,
        paddingVertical: 11,
      }}
    >
      <View style={{ paddingTop: 3 }}>
        <StatusGlyph status={task.status} size={16} animated={live} />
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <T
          numberOfLines={2}
          style={{ fontSize: 16, lineHeight: 22 }}
          tone={task.status === "canceled" ? "secondary" : "ink"}
        >
          {taskTitle(task)}
        </T>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          {task.priority > 0 && (
            <PriorityGlyph priority={task.priority} size={12} color={colors.secondary} />
          )}
          <T variant="caption" tone="muted" style={{ fontVariant: ["tabular-nums"] }}>
            {task.key}
          </T>
          {detail ? (
            <>
              {run && (
                <View style={{ marginStart: 4 }}>
                  <ProviderMark kind={run.provider.kind} size={11} color={colors.secondary} />
                </View>
              )}
              <T
                variant="caption"
                tone="secondary"
                numberOfLines={1}
                style={{ flexShrink: 1, fontVariant: ["tabular-nums"] }}
              >
                {detail}
              </T>
            </>
          ) : where ? (
            <>
              <View style={{ marginStart: 4 }}>
                <ProjectDot projectId={task.project_id} />
              </View>
              <T variant="caption" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
                {where}
              </T>
            </>
          ) : null}
        </View>
      </View>
      <T
        variant="caption"
        tone="muted"
        style={{ paddingTop: 2, fontVariant: ["tabular-nums"] }}
      >
        {ageLabel(task.updated_at, now)}
      </T>
    </Tap>
  );
});
