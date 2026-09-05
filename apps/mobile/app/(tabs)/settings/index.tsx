// The machine you are connected to, what it is doing right now, what the week
// cost, and the way out.

import React, { useCallback, useEffect, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Stack, useRouter } from "expo-router";
import * as Application from "expo-application";
import { useConnection } from "@/connection/ConnectionContext";
import { formatTokens } from "@/lib/time";
import type { DaemonActivity, DaemonInfo, UsageSummaryResult } from "@/protocol";
import { Button } from "@/ui/Button";
import { Card, Row } from "@/ui/Card";
import { Screen, Txt } from "@/ui/Screen";
import { StatusGlyph } from "@/ui/StatusGlyph";
import { GUTTER, space, useTheme } from "@/ui/theme";

export default function SettingsScreen() {
  const th = useTheme();
  const router = useRouter();
  const { client, endpoint, status, disconnect } = useConnection();
  const [info, setInfo] = useState<DaemonInfo | null>(null);
  const [activity, setActivity] = useState<DaemonActivity | null>(null);
  const [usage, setUsage] = useState<UsageSummaryResult | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!client || client.status !== "open") return;
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const [i, a, u] = await Promise.allSettled([
      client.call("daemon.info", {}),
      client.call("daemon.activity", {}),
      client.call("usage.summary", { since, group_by: "provider" }),
    ]);
    if (i.status === "fulfilled") setInfo(i.value);
    if (a.status === "fulfilled") setActivity(a.value);
    if (u.status === "fulfilled") setUsage(u.value);
  }, [client]);

  useEffect(() => {
    void load();
    if (!client) return;
    const off = client.onStatus((s) => {
      if (s === "open") void load();
    });
    const timer = setInterval(() => void load(), 15_000);
    return () => {
      off();
      clearInterval(timer);
    };
  }, [client, load]);

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const host = endpoint ? endpoint.url.replace(/^wss?:\/\//, "").replace(/\/ws$/, "") : "";
  const connected = status === "open";

  return (
    <Screen>
      <Stack.Screen options={{ title: "Settings", headerLargeTitleEnabled: true }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={th.textSecondary} />}
      >
        <Card title="Environment">
          <Row
            icon="computer"
            label={info?.hostname ?? host}
            detail={info ? `${info.os} · ${info.arch}` : host}
            trailing={
              <View style={styles.status}>
                <StatusGlyph status={connected ? "idle" : "failed"} size={8} />
                <Txt variant="subhead" tone="secondary" color={connected ? th.completed : th.failed}>
                  {connected ? "Connected" : status === "reconnecting" ? "Reconnecting" : "Offline"}
                </Txt>
              </View>
            }
          />
          <Row icon="link" label="Address" value={host} mono />
          <Row icon="sparkles" label="Daemon" value={info ? `v${info.version} · protocol ${info.protocol_version}` : "—"} last />
        </Card>

        <Card title="Right now">
          <Row icon="threads" label="Running threads" value={activity ? String(activity.running_threads) : "—"} />
          <Row icon="signal" label="Live agent sessions" value={activity ? `${activity.live_sessions} live · ${activity.idle_sessions} idle` : "—"} />
          <Row icon="terminal" label="Terminals" value={activity ? String(activity.terminals) : "—"} />
          <Row icon="phone" label="Connections" value={activity ? String(activity.connections) : "—"} last />
        </Card>

        <Card title="Last 7 days">
          <Row icon="clock" label="Turns" value={usage ? usage.total.turns.toLocaleString() : "—"} />
          <Row icon="json" label="Tokens" value={usage ? formatTokens(usage.total.usage.input_tokens + usage.total.usage.output_tokens) : "—"} />
          <Row icon="bolt" label="Cost" value={usage ? `$${usage.total.cost_usd.toFixed(2)}` : "—"} last={!usage || usage.rows.length === 0} />
          {usage?.rows.map((r, i) => (
            <Row key={r.key} label={r.key} value={`${r.turns} turns · $${r.cost_usd.toFixed(2)}`} last={i === usage.rows.length - 1} />
          ))}
        </Card>

        <Card title="This phone">
          <Row icon="phone" label="Kybern" value={`${Application.nativeApplicationVersion ?? "0.1.0"} (${Application.nativeBuildVersion ?? "dev"})`} last />
        </Card>

        <View style={styles.footer}>
          <Button
            title="Disconnect from this machine"
            icon="logout"
            destructive
            onPress={() => void disconnect().then(() => router.replace("/connect"))}
          />
          <Txt variant="footnote" tone="tertiary" style={{ textAlign: "center" }}>
            Removes the device credential from this phone. Pair again from the desktop app.
          </Txt>
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: GUTTER, paddingTop: space.md, paddingBottom: 120, gap: space.xl },
  status: { flexDirection: "row", alignItems: "center", gap: 6 },
  footer: { gap: space.md, paddingHorizontal: space.sm },
});
