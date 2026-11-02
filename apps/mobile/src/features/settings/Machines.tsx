// Settings → Machines (design §5.3): every machine this phone sees, with its
// status, Pause and Remove; the machines Kybern found on your tailnet to add;
// and adding one with a code. The phone is a client of the network, never a
// member: it changes the network through the computer it is at.
import { router } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { updateSummary } from "../../../../../packages/kybern-client/src/networkSettings";
import type { FoundMachine, MachineId, NetworkStatus } from "../../../../../packages/kybern-client/src/types";
import { parityFooter } from "../../machines/gate";
import { machineStatusLine, sameNameAddresses } from "../../machines/labels";
import { cancelOutboxText, deviceSubtitle, groupDevices, MACHINES_COPY, outboxEntries, type DeviceGroup, type OutboxEntry } from "../../machines/settingsModel";
import {
  addFoundMachine,
  canManageNetwork,
  joinWithCode,
  listPairedDevices,
  memberMachine,
  memberParity,
  networkStatus,
  olderMembers,
  revokeDeviceTokens,
  setFollowUpdates,
  setNetworkEnabled,
  updateAllMachines,
} from "../../state/machineActions";
import { cancelOutboxItem, listOutboxes, onOutboxesChanged, retryOutboxItem } from "../../state/outbox";
import { errorText, machineHub, useApp, useMachineView } from "../../state/runtime";
import { Alert, confirm } from "../../ui/Alert";
import { MenuButton } from "../../ui/ActionMenu";
import { ListRow } from "../../ui/List";
import { Button, ErrorBanner, Field } from "../../ui/primitives";
import { Busy } from "../../ui/Busy";
import { space } from "../../ui/theme";
import { MachineGlyph, StatusDot } from "../MachineGlyph";
import { Section, ToggleRow } from "./common";
import { machineMenu } from "./machineActions";

export function MachinesSettings() {
  const app = useApp();
  const view = useMachineView();
  const [error, setError] = useState("");
  const [network, setNetwork] = useState<NetworkStatus | null>(null);
  const [adding, setAdding] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateLine, setUpdateLine] = useState("");
  const [outbox, setOutbox] = useState<OutboxEntry[]>([]);
  const [devices, setDevices] = useState<DeviceGroup[]>([]);
  const hub = machineHub();
  const manage = canManageNetwork();
  const connections = hub.connections();
  const found: FoundMachine[] = network?.found ?? [];
  const gated = manage && memberParity();
  const older = manage ? olderMembers() : [];
  const memberName = memberMachine()?.name ?? "this machine";
  // Saved computers that share a name (old scratch daemons) are told apart by their address.
  const addresses = sameNameAddresses(connections.map((c) => ({ id: c.record.machineId, name: c.record.name, routes: c.record.routes })));
  const live = (status: string) => status === "online" || status === "relaying" || status === "needs-update";
  const hereConnection = connections.find((c) => c.record.machineId === app.activeId);
  // The computer the phone goes through stopped answering while another saved one is up: say how to switch.
  const hereDown =
    !!hereConnection && app.status !== "open" && !live(hereConnection.status) &&
    connections.some((c) => c.record.machineId !== app.activeId && live(c.status) && app.environments.some((e) => e.id === c.record.machineId));

  // What the network found on the tailnet, read from a member whenever the list of machines changes.
  const reloadFound = useCallback(async () => {
    if (!canManageNetwork()) return setNetwork(null);
    try {
      setNetwork(await networkStatus());
    } catch {
      setNetwork(null);
    }
  }, []);
  useEffect(() => {
    void reloadFound();
  }, [reloadFound, view.version]);

  // Outbox and paired devices span every live machine, so they read again when the machines change.
  const names = new Map(connections.map((c) => [c.record.machineId, c.record.name] as const));
  const reloadOutbox = useCallback(async () => {
    if (!gated) return setOutbox([]);
    const lists = await listOutboxes();
    setOutbox(outboxEntries(lists, new Map(machineHub().connections().map((c) => [c.record.machineId, c.record.name] as const))));
  }, [gated]);
  useEffect(() => {
    void reloadOutbox().catch(() => {});
    return gated ? onOutboxesChanged(() => void reloadOutbox().catch(() => {})) : undefined;
  }, [reloadOutbox, gated, view.version]);
  useEffect(() => {
    if (!gated) return setDevices([]);
    let live = true;
    listPairedDevices().then(
      (entries) => live && setDevices(groupDevices(entries)),
      () => live && setDevices([]),
    );
    return () => {
      live = false;
    };
  }, [gated, view.version]);

  const run = (work: () => Promise<unknown>) => {
    setError("");
    work().catch((e) => setError(errorText(e)));
  };

  const networkPaused = (id: MachineId) => network?.members.find((card) => card.machine_id === id)?.status === "paused";
  const updateAll = () => {
    setUpdating(true);
    setUpdateLine("");
    updateAllMachines()
      .then((result) => setUpdateLine(updateSummary(result)))
      .catch((e) => setError(errorText(e)))
      .finally(() => setUpdating(false));
  };
  const turnOff = () =>
    confirm({
      title: MACHINES_COPY.offTitle(memberName),
      message: MACHINES_COPY.offBody(memberName),
      confirm: MACHINES_COPY.offButton,
      onConfirm: () => run(async () => { await setNetworkEnabled(false); await reloadFound(); }),
    });
  const cancelItem = (entry: OutboxEntry) => {
    const text = cancelOutboxText(entry);
    Alert.alert(text.title, text.message, [
      { text: MACHINES_COPY.keep, style: "cancel" },
      { text: MACHINES_COPY.cancelSend, style: "destructive", onPress: () => run(async () => { await cancelOutboxItem(entry.holder, entry.id); await reloadOutbox(); }) },
    ]);
  };
  const revokeGroup = (group: DeviceGroup) =>
    confirm({
      title: `Revoke “${group.label}”?`,
      message: "This device loses access to these machines until it pairs again.",
      confirm: "Revoke access",
      onConfirm: () => run(async () => { await revokeDeviceTokens(group.tokens); setDevices((list) => list.filter((item) => item !== group)); }),
    });

  return (
    <>
      <ErrorBanner error={error || (app.error && !connections.length ? app.error : "")} />
      <Section
        title="Your machines"
        first
        footer={
          hereDown && hereConnection
            ? MACHINES_COPY.hereDown(hereConnection.record.name)
            : connections.length
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
          const state = {
            id,
            name: connection.record.name,
            member: connection.record.member,
            here,
            disconnected: paused,
            networkPaused: networkPaused(id),
            open: app.status === "open",
            offline: connection.status === "offline",
            switchable: !here && live(connection.status) && app.environments.some((e) => e.id === id),
          };
          const address = addresses.get(id);
          const line = address ? `${address} · ${subtitle}` : subtitle;
          return (
            <ListRow
              key={id}
              title={connection.record.name}
              subtitle={here ? `${line} · Paired with this phone` : line}
              subtitleLines={2}
              leading={summary ? <MachineGlyph glyph={summary.glyph} size={24} /> : "laptopcomputer"}
              trailing={<StatusDot status={connection.status} connecting={connection.connecting} />}
              dimmed={connection.status === "offline" || paused}
              label={`${connection.record.name}, ${line}`}
              chevron
              onPress={() => router.push({ pathname: "/machine/[id]", params: { id } })}
              menu={machineMenu(state, run, { activeId: app.activeId })}
            />
          );
        })}
      </Section>
      {manage && (gated || older.length) ? (
        <Section title={MACHINES_COPY.yourNetwork} footer={older.length ? parityFooter(older) : undefined}>
          {gated ? (
            <ToggleRow
              title={MACHINES_COPY.useNetwork}
              subtitle={MACHINES_COPY.useNetworkFooter}
              value={network?.enabled ?? true}
              leading="globe"
              onChange={(value) => (value ? run(async () => { await setNetworkEnabled(true); await reloadFound(); }) : turnOff())}
            />
          ) : null}
          {gated ? (
            <ToggleRow
              title={MACHINES_COPY.follow}
              subtitle={MACHINES_COPY.followFooter}
              value={network?.follow_updates ?? false}
              leading="arrow.clockwise"
              onChange={(value) => run(async () => { await setFollowUpdates(value); await reloadFound(); })}
            />
          ) : null}
          {gated ? (
            <ListRow
              title={MACHINES_COPY.updateAll}
              subtitle={updateLine || undefined}
              leading="arrow.up"
              trailing={updating ? <Busy /> : undefined}
              disabled={updating}
              onPress={updateAll}
            />
          ) : null}
          {gated ? <ListRow title={MACHINES_COPY.check} leading="checkmark.circle" chevron onPress={() => router.push("/network-check")} /> : null}
        </Section>
      ) : null}
      {gated && outbox.length ? (
        <Section title={MACHINES_COPY.outbox}>
          {outbox.map((entry) => (
            <ListRow
              key={entry.id}
              title={entry.title}
              subtitle={entry.detail}
              subtitleLines={3}
              leading="paperplane"
              trailing={
                entry.canRetry || entry.canCancel ? (
                  <MenuButton
                    label={`${entry.title}. Actions`}
                    items={[
                      ...(entry.canRetry ? [{ title: MACHINES_COPY.retry, icon: "arrow.clockwise" as const, onPress: () => run(async () => { await retryOutboxItem(entry.holder, entry.id); await reloadOutbox(); }) }] : []),
                      ...(entry.canCancel ? [{ title: MACHINES_COPY.cancel, icon: "xmark.circle" as const, destructive: true, onPress: () => cancelItem(entry) }] : []),
                    ]}
                  />
                ) : undefined
              }
              menu={[
                ...(entry.canRetry ? [{ title: MACHINES_COPY.retry, icon: "arrow.clockwise" as const, onPress: () => run(async () => { await retryOutboxItem(entry.holder, entry.id); await reloadOutbox(); }) }] : []),
                ...(entry.canCancel ? [{ title: MACHINES_COPY.cancel, icon: "xmark.circle" as const, destructive: true, onPress: () => cancelItem(entry) }] : []),
              ]}
            />
          ))}
        </Section>
      ) : null}
      {found.length ? (
        <Section title="Found on your tailnet" footer="Add a machine you own to use it from this phone too.">
          {found.map((machine) => (
            <ListRow
              key={machine.found_id}
              title={machine.name}
              subtitle={
                machine.action === "code"
                  ? "Needs a code · Add by code below"
                  : machine.action === "merge"
                    ? MACHINES_COPY.mergeDetail
                    : [machine.os, machine.version ? `Version ${machine.version}` : null].filter(Boolean).join(" · ") || "On your tailnet"
              }
              subtitleLines={2}
              leading="laptopcomputer"
              trailing={
                machine.action === "code" ? undefined : (
                  <Button
                    size="medium"
                    role="plain"
                    label={machine.action === "merge" ? `Merge ${machine.name}'s network with yours` : `Add ${machine.name}`}
                    onPress={() => {
                      const add = () =>
                        run(async () => {
                          const result = await addFoundMachine(machine);
                          if (result.needs_code) throw new Error(`Show a code on ${machine.name}, then add it by code.`);
                          await reloadFound();
                        });
                      // Merging changes both networks, so it asks first; adding one machine does not.
                      if (machine.action === "merge")
                        confirm({ title: MACHINES_COPY.mergeTitle(machine.name), message: MACHINES_COPY.mergeBody(machine.name), confirm: MACHINES_COPY.mergeButton, onConfirm: add });
                      else add();
                    }}
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
      {gated && devices.length ? (
        <Section title={MACHINES_COPY.devices} footer="Swipe or touch and hold a device to revoke it on every machine it reaches.">
          {devices.map((group) => (
            <ListRow
              key={group.label}
              title={group.label}
              subtitle={deviceSubtitle(group)}
              subtitleLines={2}
              leading="lock.shield"
              menu={[{ title: "Revoke access", icon: "trash", destructive: true, onPress: () => revokeGroup(group) }]}
              swipe={{ trailing: [{ title: "Revoke", icon: "trash", tone: "negative", onPress: () => revokeGroup(group) }] }}
            />
          ))}
        </Section>
      ) : null}
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
