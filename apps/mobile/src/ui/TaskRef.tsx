import { router } from "expo-router";
import { Text, View } from "react-native";
import { useTask } from "../state/tasks";
import { STATUS_LABEL } from "../state/tasksModel";
import { StatusGlyph } from "./TaskGlyphs";
import { useTheme } from "./theme";

/**
 * A `kybern://task/<id>` link drawn as a live reference: the task's status glyph
 * and key, plus its status word on checklist lines. It follows the task as it
 * runs and opens it on tap. Before the task list arrives it shows the link text.
 */
export function TaskRef({
  id,
  label,
  checklist = false,
}: {
  id: string;
  label: string;
  checklist?: boolean;
}) {
  const task = useTask(id);
  const { colors } = useTheme();
  const key = task?.key ?? label;
  return (
    <Text
      accessibilityRole="link"
      accessibilityLabel={`${key}${task ? `, ${STATUS_LABEL[task.status]}` : ""}. Open task`}
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
      {checklist && task ? (
        <Text style={{ color: colors.secondary, fontWeight: "400" }}>
          {`  ${STATUS_LABEL[task.status]}`}
        </Text>
      ) : null}
    </Text>
  );
}
