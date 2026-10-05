import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { dismissToast, restoreTask, useTasks } from "../state/tasks";
import { Icon, styles, T, Tap } from "../ui/primitives";
import { useTheme } from "../ui/theme";
import { attempt, openThread } from "./taskActions";

/** "ADE-14 started · Open" or "ADE-14 deleted · Undo", above the home indicator. */
export function TaskToast() {
  const { toast } = useTasks();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  if (!toast) return null;
  const action = toast.action;
  return (
    <Animated.View
      key={toast.id}
      entering={FadeIn.duration(160)}
      exiting={FadeOut.duration(120)}
      accessibilityLiveRegion="polite"
      style={{
        position: "absolute",
        start: 16,
        end: 16,
        bottom: insets.bottom + 12,
        alignSelf: "center",
        maxWidth: 520,
        minHeight: 52,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        paddingStart: 18,
        paddingEnd: action ? 6 : 18,
        borderRadius: 18,
        backgroundColor: colors.ink,
      }}
    >
      <T
        variant="label"
        tone="inverse"
        numberOfLines={1}
        style={{ flex: 1, fontVariant: ["tabular-nums"] }}
      >
        {toast.text}
      </T>
      {action?.kind === "undo" && (
        <Tap
          label="Undo delete"
          onPress={() => attempt(() => restoreTask(action.taskId))}
          style={[styles.line, { gap: 6, paddingHorizontal: 12 }]}
        >
          <Icon name="arrow.uturn.backward" size={15} color={colors.inverse} />
          <T variant="label" tone="inverse">
            Undo
          </T>
        </Tap>
      )}
      {action?.kind === "open" && (
        <Tap
          label="Open run"
          onPress={() => {
            dismissToast();
            openThread(action.threadId);
          }}
          style={{ paddingHorizontal: 12 }}
        >
          <T variant="label" tone="inverse">
            Open
          </T>
        </Tap>
      )}
    </Animated.View>
  );
}
