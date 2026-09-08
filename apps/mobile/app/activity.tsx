import { router } from "expo-router";
import { View } from "react-native";
import { ApprovalPanel } from "../src/features/Approvals";
import { useApp } from "../src/state/runtime";
import { Empty, Group, Page, Row, T } from "../src/ui/primitives";
export default function Activity() {
  const app = useApp();
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
  return (
    <Page>
      <T tone="secondary" style={{ marginBottom: 28 }}>
        Review approvals and follow running agents and background tasks.
      </T>
      <Group title="Needs your attention">
        {app.approvals.length ? (
          app.approvals.map((a) => (
            <View key={a.id} style={{ gap: 10, marginBottom: 20 }}>
              <Row
                title={
                  app.threads.find((t) => t.id === a.thread_id)?.title ||
                  "Open thread"
                }
                icon="text.bubble"
                onPress={() =>
                  router.push({
                    pathname: "/thread/[id]",
                    params: { id: a.thread_id },
                  })
                }
              />
              <ApprovalPanel approval={a} />
            </View>
          ))
        ) : (
          <T variant="label" tone="secondary">
            You’re all caught up.
          </T>
        )}
      </Group>
      <Group title="Working now">
        {running.length ? (
          running.map((t) => (
            <Row
              key={t.id}
              title={t.title || "Untitled thread"}
              detail={(() => {
                const a = app.activity.find((a) => a.thread_id === t.id);
                return [
                  app.projects.find((p) => p.id === t.project_id)?.name,
                  a?.active_agents ? `${a.active_agents} agents` : "",
                  a?.active_processes ? `${a.active_processes} processes` : "",
                  a?.active_monitors ? `${a.active_monitors} monitors` : "",
                ]
                  .filter(Boolean)
                  .join(" · ");
              })()}
              icon="circle.dotted"
              onPress={() =>
                router.push({ pathname: "/thread/[id]", params: { id: t.id } })
              }
            />
          ))
        ) : (
          <Empty
            icon="checkmark"
            title="No pending activity"
            detail="Active threads and approval requests will appear here."
          />
        )}
      </Group>
    </Page>
  );
}
