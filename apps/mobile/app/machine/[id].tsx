// One machine: how it is doing, what it is made of and which agents it runs, with the same actions as its row's menu.
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { harnessChips, machineSpecs } from "../../../../packages/kybern-client/src/machineSpecs";
import type { MachineInfo } from "../../../../packages/kybern-client/src/types";
import { machineActionRows } from "../../src/features/settings/machineActions";
import { Section } from "../../src/features/settings/common";
import { MachineGlyph, StatusDot } from "../../src/features/MachineGlyph";
import { machineStatusLine } from "../../src/machines/labels";
import { specRows } from "../../src/machines/settingsModel";
import { canManageNetwork, networkStatus, readMachineInfo } from "../../src/state/machineActions";
import { errorText, machineHub, useApp, useMachineView } from "../../src/state/runtime";
import { ListRow, SectionFooter } from "../../src/ui/List";
import { Empty, ErrorBanner, T } from "../../src/ui/primitives";
import { gutter, radius, space, useTheme } from "../../src/ui/theme";
import { useWindowDimensions } from "react-native";

// What each machine last said about itself, so an offline machine still shows its specs.
const lastInfo = new Map<string, MachineInfo>();

export default function MachineDetail() {
  const { id = "" } = useLocalSearchParams<{ id: string }>();
  const app = useApp();
  const view = useMachineView();
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const connection = machineHub().connections().find((c) => c.record.machineId === id);
  const summary = view.machines.find((m) => m.machineId === id);
  const [info, setInfo] = useState<MachineInfo | undefined>(lastInfo.get(id));
  const [error, setError] = useState("");
  const [networkPaused, setNetworkPaused] = useState(false);
  useEffect(() => {
    if (!canManageNetwork()) return;
    let current = true;
    networkStatus().then((status) => current && setNetworkPaused(status.members.find((card) => card.machine_id === id)?.status === "paused"), () => {});
    return () => {
      current = false;
    };
  }, [id, view.version]);
  const live = connection?.status === "online" || connection?.status === "relaying" || connection?.status === "needs-update";
  useEffect(() => {
    if (!live) return;
    let current = true;
    readMachineInfo(id).then(
      (next) => {
        lastInfo.set(id, next);
        if (current) setInfo(next);
      },
      (e) => current && setError(errorText(e)),
    );
    return () => {
      current = false;
    };
  }, [id, live, view.version]);
  if (!connection) {
    return (
      <>
        <Stack.Screen options={{ title: "Machine", headerStyle: { backgroundColor: colors.grouped } }} />
        <Empty icon="laptopcomputer" title="Machine not found" detail="It may have been removed from this phone." />
      </>
    );
  }
  const relayName = connection.relayVia ? machineHub().connections().find((c) => c.record.machineId === connection.relayVia)?.record.name : undefined;
  const status = machineStatusLine({
    status: connection.status,
    ...(connection.error ? { error: connection.error.message } : {}),
    ...(connection.lastSeenAt !== undefined ? { lastSeenAt: connection.lastSeenAt } : {}),
    ...(relayName ? { relayVia: relayName } : {}),
    ...(connection.info?.version ? { version: connection.info.version } : {}),
    connecting: connection.connecting,
  });
  const rows = specRows(connection.info?.os, machineSpecs(info));
  const chips = harnessChips(info?.harnesses);
  return (
    <>
      <Stack.Screen options={{ title: connection.record.name, headerStyle: { backgroundColor: colors.grouped } }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={{ flex: 1, backgroundColor: colors.grouped }}
        contentContainerStyle={{ paddingHorizontal: gutter(width), paddingTop: space.lg, paddingBottom: space["3xl"] }}
      >
        <ErrorBanner error={error} />
        <Section first>
          <ListRow
            title={connection.record.name}
            subtitle={status}
            subtitleLines={3}
            leading={summary ? <MachineGlyph glyph={summary.glyph} size={28} /> : "laptopcomputer"}
            trailing={<StatusDot status={connection.status} connecting={connection.connecting} />}
            label={`${connection.record.name}, ${status}`}
          />
          {connection.info?.version ? <ListRow title="Kybern" value={connection.info.version} /> : null}
        </Section>
        {rows.length ? (
          <Section title="Specs">
            {rows.map((row) => (
              <ListRow key={row.label} title={row.label} value={row.value} />
            ))}
          </Section>
        ) : null}
        {chips.length ? (
          <View>
            <Section title="Agents" />
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, paddingHorizontal: space.lg }}>
              {chips.map((chip) => (
                <View
                  key={chip.kind}
                  accessible
                  accessibilityLabel={chip.signedOut ? `${chip.label}, signed out` : chip.label}
                  style={{ borderRadius: radius.full, borderWidth: 0.5, borderColor: colors.line, backgroundColor: colors.surface, paddingHorizontal: space.md, paddingVertical: 6 }}
                >
                  <T variant="footnote" tone={chip.signedOut ? "muted" : "secondary"} numberOfLines={1}>
                    {chip.signedOut ? `${chip.label} · signed out` : chip.label}
                  </T>
                </View>
              ))}
            </View>
            {chips.some((chip) => chip.signedOut) ? <SectionFooter inset>Sign in on the machine to use an agent marked signed out.</SectionFooter> : null}
          </View>
        ) : null}
        <Section title="Actions">
          {machineActionRows(
            {
              id,
              name: connection.record.name,
              member: connection.record.member,
              here: id === app.activeId,
              disconnected: connection.status === "paused",
              networkPaused,
              open: app.status === "open",
              offline: connection.status === "offline",
            },
            { activeId: app.activeId, onDeleted: () => router.back() },
            setError,
          )}
        </Section>
      </ScrollView>
    </>
  );
}
