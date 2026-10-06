import { router } from "expo-router";
import { Text, View } from "react-native";
import { useTask, useTasksKnown } from "../state/tasks";
import { STATUS_LABEL } from "../state/tasksModel";
import { StatusGlyph } from "./TaskGlyphs";
import { useTheme } from "./theme";

/** A link that is just its own `kybern://` URI says nothing more than "a task" or "a note". */
export function writtenRefLabel(label: string) {
  const text = label.replace(/\s+/g, " ").trim();
  return /^kybern:\/\//i.test(text) ? "" : text;
}

/**
 * A `kybern://task/<id>` link drawn as a live reference: the task's status glyph
 * and key, plus its status word on checklist lines. It follows the task as it
 * runs and opens it on tap. Before the task list arrives it shows the link text.
 * In a chat message (`chat`) it also reads the task's title, and a task that is
 * gone from the list reads "Deleted task" and stops being a link.
 */
export function TaskRef({
  id,
  label,
  checklist = false,
  chat = false,
}: {
  id: string;
  label: string;
  checklist?: boolean;
  chat?: boolean;
}) {
  const task = useTask(id);
  const known = useTasksKnown();
  const { colors } = useTheme();
  const written = writtenRefLabel(label);
  if (chat && !task && known)
    return (
      <Text style={{ color: colors.muted }}>Deleted task</Text>
    );
  const key = task?.key ?? (written || "Task");
  const title = chat ? task?.title.trim() : "";
  return (
    <Text
      accessibilityRole="link"
      accessibilityLabel={`${key}${title ? ` ${title}` : ""}${task ? `, ${STATUS_LABEL[task.status]}` : ""}. Open task`}
      suppressHighlighting={false}
      onPress={() => router.push({ pathname: "/todo-item", params: { id } })}
      style={{
        color: colors.ink,
        fontWeight: "500",
        textDecorationLine: "none",
        fontVariant: ["tabular-nums"],
      }}
    >
      {task ? (
        // Inline views sit on the baseline; nudge the glyph to the x-height center.
        <View style={{ width: 18, height: 14, transform: [{ translateY: 2 }] }}>
          <StatusGlyph status={task.status} size={14} />
        </View>
      ) : null}
      {key}
      {title ? ` ${title}` : null}
      {checklist && task ? (
        <Text style={{ color: colors.secondary, fontWeight: "400" }}>
          {`  ${STATUS_LABEL[task.status]}`}
        </Text>
      ) : null}
    </Text>
  );
}
