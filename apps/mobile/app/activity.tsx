import { router } from "expo-router";
import { ScrollView, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ApprovalPanel } from "../src/features/Approvals";
import { count } from "../src/state/format";
import { useApp } from "../src/state/runtime";
import { ListRow, SectionHeader } from "../src/ui/List";
import { Empty } from "../src/ui/primitives";
import { StatusGlyph } from "../src/ui/TaskGlyphs";
import { CONTENT_MAX_WIDTH, gutter, space, useTheme } from "../src/ui/theme";

const openThread = (id: string) => router.push({ pathname: "/thread/[id]", params: { id } });

/** What needs a decision, then what is running. One empty state when there is neither. */
export default function Activity() {
  const app = useApp();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const running = app.threads.filter(
    (t) =>
      t.status === "running" ||
      t.status === "awaiting-approval" ||
      app.activity.some(
        (a) =>
          a.thread_id === t.id &&
          a.active_agents + a.active_processes + a.active_monitors > 0,
      ),
  );
  const title = (threadId: string) =>
    app.threads.find((t) => t.id === threadId)?.title || "Untitled thread";
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{
        flexGrow: 1,
        paddingBottom: insets.bottom + space["2xl"],
        width: "100%",
        maxWidth: CONTENT_MAX_WIDTH,
        alignSelf: "center",
      }}
    >
      {!app.approvals.length && !running.length ? (
        <Empty
          icon="checkmark.circle"
          title="Nothing needs you"
          detail="Approvals and running agents show up here."
        />
      ) : null}
      {app.approvals.length > 0 && (
        <>
          <SectionHeader title="Needs you" count={app.approvals.length} inset first />
          {app.approvals.map((approval) => (
            <View key={approval.id} style={{ marginBottom: space.lg }}>
              <ListRow
                title={title(approval.thread_id)}
                leading={<StatusGlyph phase="waiting" size={16} />}
                chevron
                onPress={() => openThread(approval.thread_id)}
              />
              <View style={{ paddingHorizontal: gutter(width) }}>
                <ApprovalPanel approval={approval} />
              </View>
            </View>
          ))}
        </>
      )}
      {running.length > 0 && (
        <>
          <SectionHeader
            title="Working now"
            count={running.length}
            inset
            first={!app.approvals.length}
          />
          {running.map((t, index) => {
            const a = app.activity.find((x) => x.thread_id === t.id);
            const detail = [
              app.projects.find((p) => p.id === t.project_id)?.name,
              a?.active_agents ? count(a.active_agents, "agent") : "",
              a?.active_processes ? count(a.active_processes, "process", "processes") : "",
              a?.active_monitors ? count(a.active_monitors, "monitor") : "",
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <ListRow
                key={t.id}
                title={t.title || "Untitled thread"}
                subtitle={detail || undefined}
                subtitleLines={1}
                leading={
                  <StatusGlyph
                    phase={t.status === "awaiting-approval" ? "waiting" : "working"}
                    size={16}
                    animated
                  />
                }
                chevron
                separator={index < running.length - 1}
                onPress={() => openThread(t.id)}
              />
            );
          })}
        </>
      )}
    </ScrollView>
  );
}
