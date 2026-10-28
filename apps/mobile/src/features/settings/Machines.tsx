// Settings → Machines (design §5.3): every machine this phone sees, with its
// status, Pause and Remove; the machines Kybern found on your tailnet to add;
// and adding one with a code. The phone is a client of the network, never a
// member: it changes the network through the computer it is at.
import { router } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import type { FoundMachine } from "../../../../../packages/kybern-client/src/types";
import { machineStatusLine } from "../../machines/labels";
import { addFoundMachine, canManageNetwork, joinWithCode, networkStatus, removeFromNetwork } from "../../state/machineActions";
import { connect, errorText, machineHub, removeMachine, useApp, useMachineView } from "../../state/runtime";
import { Alert, confirm } from "../../ui/Alert";
import { ListRow } from "../../ui/List";
import { Button, ErrorBanner, Field } from "../../ui/primitives";
import { space } from "../../ui/theme";
import { MachineGlyph, StatusDot } from "../MachineGlyph";
import { Section } from "./common";

export function MachinesSettings() {
  const app = useApp();
  const view = useMachineView();
  const [error, setError] = useState("");
  const [found, setFound] = useState<FoundMachine[]>([]);
  const [adding, setAdding] = useState(false);
  const hub = machineHub();
  const manage = canManageNetwork();
  const connections = hub.connections();

  // What the network found on the tailnet, read from a member whenever the list of machines changes.
  const reloadFound = useCallback(async () => {
    if (!canManageNetwork()) return setFound([]);
    try {
      setFound((await networkStatus()).found);
    } catch {
      setFound([]);
    }
  }, []);
  useEffect(() => {
    void reloadFound();
  }, [reloadFound, view.version]);

  const run = (work: () => Promise<unknown>) => {
    setError("");
    work().catch((e) => setError(errorText(e)));
  };

  const remove = (id: string, name: string, member: boolean) => {
    const forget = () => run(() => removeMachine(id));
    if (!member || !manage)
      return confirm({
        title: `Forget “${name}”?`,
        message: "This removes the machine from this phone. Its projects and conversations stay on the machine.",
        confirm: "Forget machine",
        onConfirm: forget,
      });
    Alert.alert(`Remove “${name}”?`, "Removing it from your network takes it out of every machine's list. Its projects and conversations stay on it.", [
      { text: "Cancel", style: "cancel" },
      { text: "Forget on this phone only", onPress: forget },
      {
        text: "Remove from your network",
        style: "destructive",
        onPress: () => run(async () => { await removeFromNetwork(id, false); await removeMachine(id); }),
      },
      {
        text: "Lost or stolen",
        style: "destructive",
        onPress: () => run(async () => { await removeFromNetwork(id, true); await removeMachine(id); }),
      },
    ]);
  };

  return (
    <>
      <ErrorBanner error={error || (app.error && !connections.length ? app.error : "")} />
      <Section
        title="Your machines"
        first
        footer={
          connections.length
            ? "Pair this phone once and it reaches every machine on your network. Touch and hold a machine for more."
            : "Connect a computer to get started."
        }
      >
        {connections.map((connection) => {
          const id = connection.record.machineId;
          const summary = view.machines.find((m) => m.machineId === id);
          const here = id === app.activeId;
          const paused = connection.status === "paused";
          const relayName = connection.relayVia ? connections.find((c) => c.record.machineId === connection.relayVia)?.record.name : undefined;
          const subtitle = machineStatusLine({
            status: connection.status,
            ...(connection.error ? { error: connection.error.message } : {}),
            ...(connection.lastSeenAt !== undefined ? { lastSeenAt: connection.lastSeenAt } : {}),
            ...(relayName ? { relayVia: relayName } : {}),
            ...(connection.info?.version ? { version: connection.info.version } : {}),
            connecting: connection.connecting,
          });
          return (
            <ListRow
              key={id}
              title={connection.record.name}
              subtitle={here ? `${subtitle} · This phone is here` : subtitle}
              subtitleLines={2}
              leading={summary ? <MachineGlyph glyph={summary.glyph} size={24} /> : "laptopcomputer"}
              trailing={<StatusDot status={connection.status} connecting={connection.connecting} />}
              dimmed={connection.status === "offline" || paused}
              label={`${connection.record.name}, ${subtitle}`}
              menu={[
                ...(here
                  ? app.status !== "open"
                    ? [{ title: "Reconnect", icon: "arrow.clockwise" as const, onPress: () => connect(app.activeId) }]
                    : []
                  : [
                      ...(!paused ? [{ title: "Try again", icon: "arrow.clockwise" as const, onPress: () => run(() => hub.retry(id)) }] : []),
                      paused
                        ? { title: "Resume", icon: "arrow.right" as const, onPress: () => run(() => hub.setPaused(id, false)) }
                        : { title: "Pause", icon: "pause.circle" as const, onPress: () => run(() => hub.setPaused(id, true)) },
                    ]),
                {
                  title: connection.record.member && manage ? "Remove…" : "Forget machine",
                  icon: "trash" as const,
                  destructive: true,
                  onPress: () => remove(id, connection.record.name, connection.record.member),
                },
              ]}
            />
          );
        })}
      </Section>
      {found.length ? (
        <Section title="Found on your tailnet" footer="Add a machine you own to use it from this phone too.">
          {found.map((machine) => (
            <ListRow
              key={machine.found_id}
              title={machine.name}
              subtitle={machine.action === "code" ? "Needs a code · Add by code below" : machine.os ?? "On your tailnet"}
              leading="laptopcomputer"
              trailing={
                machine.action === "code" ? undefined : (
                  <Button
                    size="medium"
                    role="plain"
                    onPress={() => run(async () => {
                      const result = await addFoundMachine(machine);
                      if (result.needs_code) throw new Error(`Show a code on ${machine.name}, then add it by code.`);
                      await reloadFound();
                    })}
                  >
                    {machine.action === "merge" ? "Merge" : "Add"}
                  </Button>
                )
              }
            />
          ))}
        </Section>
      ) : null}
      <Section title="Add a machine">
        {manage ? (
          <ListRow title="Add by code" subtitle="Enter the code shown on the other machine" leading="plus" chevron onPress={() => setAdding((open) => !open)} />
        ) : null}
        {manage && adding ? <AddByCode onDone={() => { setAdding(false); void reloadFound(); }} onError={setError} /> : null}
        <ListRow title="Pair another computer" subtitle="With a pairing code, QR code or access token" leading="qrcode.viewfinder" chevron onPress={() => router.push("/connect")} />
      </Section>
    </>
  );
}

/** The machine at `address` shows a six-digit code; a member joins it with that code. */
function AddByCode({ onDone, onError }: { onDone: () => void; onError: (message: string) => void }) {
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = !!address.trim() && /^\d{6}$/.test(code.trim());
  return (
    <View style={{ gap: space.lg, padding: space.lg }}>
      <Field label="Machine address" placeholder="100.64.0.2:4173" value={address} onChangeText={setAddress} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
      <Field label="Code" variant="code" placeholder="000000" value={code} onChangeText={(text) => setCode(text.replace(/\D/g, ""))} maxLength={6} />
      <Button
        busy={busy}
        disabled={!ready}
        onPress={() => {
          setBusy(true);
          onError("");
          joinWithCode(code, address)
            .then(onDone)
            .catch((e) => onError(errorText(e)))
            .finally(() => setBusy(false));
        }}
      >
        Add machine
      </Button>
    </View>
  );
}
