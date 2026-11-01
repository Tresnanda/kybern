// "Check the network": what `network.doctor` found, failures first, each with what to do next.
import { Stack } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import { doctorSummary } from "../../../packages/kybern-client/src/networkSettings";
import type { DoctorReport } from "../../../packages/kybern-client/src/types";
import { checkRows, MACHINES_COPY } from "../src/machines/settingsModel";
import { checkNetwork } from "../src/state/machineActions";
import { machineHub, useMachineView } from "../src/state/runtime";
import { Busy } from "../src/ui/Busy";
import { InsetGroup, ListRow } from "../src/ui/List";
import { Button, Icon, T } from "../src/ui/primitives";
import { space, useTheme } from "../src/ui/theme";

const ICON = { good: "checkmark.circle", warn: "exclamationmark.triangle", bad: "xmark.circle" } as const;

export default function NetworkCheck() {
  const { colors } = useTheme();
  const view = useMachineView();
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [failed, setFailed] = useState(false);
  const [run, setRun] = useState(0);
  useEffect(() => {
    let live = true;
    setReport(null);
    setFailed(false);
    checkNetwork().then((next) => live && setReport(next), () => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [run]);
  const names = useMemo(() => new Map(machineHub().set.connections().map((c) => [c.record.machineId, c.record.name])), [view.version]);
  const rows = report ? checkRows(report, names) : [];
  const tone = { good: colors.positive, warn: colors.warning, bad: colors.negative } as const;
  return (
    <>
      <Stack.Screen options={{ title: MACHINES_COPY.check, headerStyle: { backgroundColor: colors.grouped } }} />
      <ScrollView style={{ flex: 1, backgroundColor: colors.grouped }} contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
        {failed ? (
          <View style={{ gap: space.md, alignItems: "flex-start" }}>
            <T variant="subhead" tone="secondary">
              {MACHINES_COPY.checkError}
            </T>
            <Button size="medium" icon="arrow.clockwise" onPress={() => setRun((n) => n + 1)}>
              Check again
            </Button>
          </View>
        ) : !report ? (
          <Busy />
        ) : (
          <>
            <T variant="subhead" tone="secondary">
              {doctorSummary(report)}
            </T>
            <InsetGroup>
              {rows.map((row) => (
                <ListRow
                  key={row.id}
                  title={row.title}
                  titleLines={3}
                  subtitle={row.next || undefined}
                  subtitleLines={4}
                  leading={<Icon name={ICON[row.tone]} size={20} color={tone[row.tone]} />}
                  label={`${row.tone === "good" ? "Passed" : row.tone === "warn" ? "Needs a look" : "Failed"}: ${row.title}`}
                />
              ))}
            </InsetGroup>
          </>
        )}
      </ScrollView>
    </>
  );
}
