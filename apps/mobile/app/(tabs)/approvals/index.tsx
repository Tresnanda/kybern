// Everything waiting on you, across every thread. The reason the app exists
// on a phone.

import React, { useCallback, useMemo, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Stack, useRouter } from "expo-router";
import Animated, { LinearTransition } from "react-native-reanimated";
import { useConnection } from "@/connection/ConnectionContext";
import type { ApprovalDecision, ApprovalRequest } from "@/protocol";
import { forgetApproval, refreshDaemon, useDaemon } from "@/state/daemon";
import { ApprovalCard } from "@/ui/ApprovalCard";
import { ConnectionBanner } from "@/ui/Banner";
import { Glass } from "@/ui/Glass";
import { Icon } from "@/ui/Icon";
import { Screen, Txt } from "@/ui/Screen";
import { GUTTER, radius, space, useTheme } from "@/ui/theme";

export default function ApprovalsScreen() {
  const th = useTheme();
  const router = useRouter();
  const { client, status, statusDetail } = useConnection();
  const { approvals, threads, projects, loaded } = useDaemon();
  const [refreshing, setRefreshing] = useState(false);

  const list = useMemo(() => [...approvals.values()].sort((a, b) => a.created_at.localeCompare(b.created_at)), [approvals]);

  const refresh = useCallback(async () => {
    if (!client) return;
    setRefreshing(true);
    await refreshDaemon(client);
    setRefreshing(false);
  }, [client]);

  const respond = useCallback(
    async (approval: ApprovalRequest, decision: ApprovalDecision) => {
      if (!client) throw new Error("Not connected");
      await client.call("approvals.respond", { approval_id: approval.id, ...decision });
      forgetApproval(approval.id);
    },
    [client],
  );

  const contextFor = (a: ApprovalRequest) => {
    const thread = threads.get(a.thread_id);
    const project = thread ? projects.find((p) => p.id === thread.project_id) : null;
    return [project?.name, thread?.title || "Untitled"].filter(Boolean).join(" · ");
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: "Approvals", headerLargeTitleEnabled: true }} />
      <ConnectionBanner status={status} detail={statusDetail} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.list, list.length === 0 ? styles.listEmpty : null]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={th.textSecondary} />}
      >
        {list.length === 0 && loaded ? (
          <View style={styles.empty}>
            <Glass radius={radius.pill} style={styles.emptyGlyph}>
              <Icon name="check" size={26} color={th.completed} weight="bold" />
            </Glass>
            <Txt variant="title3" style={{ textAlign: "center" }}>
              Nothing waiting on you
            </Txt>
            <Txt variant="subhead" tone="secondary" style={{ textAlign: "center", maxWidth: 280 }}>
              When an agent needs permission to run a command or edit a file, it shows up here.
            </Txt>
          </View>
        ) : null}
        {list.map((a) => (
          <Animated.View key={a.id} layout={LinearTransition.springify().damping(20).stiffness(220)}>
            <ApprovalCard approval={a} context={contextFor(a)} onRespond={(d) => respond(a, d)} onOpen={() => router.push({ pathname: "/thread/[id]", params: { id: a.thread_id } })} />
          </Animated.View>
        ))}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: GUTTER, paddingTop: space.md, paddingBottom: 120, gap: space.md },
  listEmpty: { flexGrow: 1 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.sm, paddingBottom: 80 },
  emptyGlyph: { width: 64, height: 64, alignItems: "center", justifyContent: "center", marginBottom: space.sm },
});
