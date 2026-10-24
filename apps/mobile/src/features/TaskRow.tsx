import { memo, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import type { TaskItem } from "../state/protocol";
import { deleteTask } from "../state/tasks";
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
import { useMenuSurface } from "../ui/ActionMenu";
import { Check } from "../ui/CheckRow";
import { ListRow, type SwipeAction } from "../ui/List";
import { StatusGlyph } from "../ui/TaskGlyphs";
import { attempt, changeStatus, openTask, taskMenuItems } from "./taskActions";

/** A clock for elapsed times and ages; ticks once a minute while mounted. */
export function useMinuteClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** What the row says under the title: what the agent is doing, the run's diff, or where the task lives. */
export function taskDetail(task: TaskItem, now: number, where = "") {
  const run = latestRun(task);
  if (task.status === "running" && run && isLiveRun(run))
    return run.state === "waiting"
      ? "Waiting for you"
      : [run.activity ? shortActivity(run.activity) : "Working", shortDuration(runDuration(run, now))].join(" · ");
  if (task.status === "needs_review" && run) return diffLabel(run.diff) || "Ready for review";
  return where;
}

/**
 * One task: status glyph, title, then a quiet line with priority, key and either
 * what the agent is doing, the run's diff, or the project. Age sits on the right.
 * Swipe right to finish it; swipe left for More and Delete. While selecting, the
 * glyph becomes a check and a tap toggles the task.
 */
export const TaskRow = memo(function TaskRow({
  task,
  projectName,
  showProject,
  now,
  separator,
  selecting = false,
  selected = false,
  onToggleSelect,
  swipeable = true,
}: {
  task: TaskItem;
  projectName?: string;
  showProject: boolean;
  now: number;
  separator?: boolean;
  selecting?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
  /** Off where the row sits in a sideways pager (the board). */
  swipeable?: boolean;
}) {
  const anchor = useRef<View>(null);
  const more = useMenuSurface();
  const live = task.status === "running" && isLiveRun(latestRun(task));
  const where = showProject ? (task.project_id ? (projectName ?? "Project") : "Global") : "";
  const detail = taskDetail(task, now, where);
  const subtitle = [task.priority ? PRIORITY_LABEL[task.priority] : "", task.key, detail]
    .filter(Boolean)
    .join(" · ");
  const title = taskTitle(task);
  const label = [title, STATUS_LABEL[task.status], subtitle, selecting ? (selected ? "selected" : "not selected") : ""]
    .filter(Boolean)
    .join(", ");
  const menuTitle = `${task.key} · ${title}`;
  const done = task.status === "done";
  const leading: SwipeAction[] = [
    done
      ? { title: "To do", icon: "arrow.uturn.backward", tone: "accent", full: true, onPress: () => changeStatus(task, "todo") }
      : { title: "Done", icon: "checkmark", tone: "positive", full: true, onPress: () => changeStatus(task, "done") },
  ];
  const trailing: SwipeAction[] = [
    {
      title: "More",
      icon: "ellipsis",
      tone: "neutral",
      onPress: () =>
        anchor.current?.measureInWindow((x, y, width, height) =>
          more.show({ items: taskMenuItems(task), title: menuTitle, origin: { x, y, width, height }, originRadius: 0 }),
        ),
    },
    {
      title: "Delete",
      icon: "trash",
      tone: "negative",
      full: true,
      onPress: () => attempt(() => deleteTask(task.id)),
    },
  ];
  return (
    <View ref={anchor} collapsable={false}>
      <ListRow
        title={title}
        titleLines={2}
        subtitle={subtitle}
        subtitleLines={1}
        leading={
          selecting ? (
            <Check checked={selected} size={22} />
          ) : (
            <StatusGlyph status={task.status} size={16} animated={live} />
          )
        }
        meta={ageLabel(task.updated_at, now)}
        label={label}
        onPress={selecting ? () => onToggleSelect?.(task.id) : () => openTask(task.id)}
        menu={selecting ? undefined : taskMenuItems(task)}
        menuTitle={menuTitle}
        swipe={selecting || !swipeable ? undefined : { leading, trailing }}
        separator={separator}
      />
      {more.element}
    </View>
  );
});
