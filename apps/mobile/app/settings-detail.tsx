import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { Toggle } from "../src/ui/Toggle";
import { Alert } from "../src/ui/Alert";
import {
  type DaemonActivity,
  type DaemonUpdate,
  type HarnessUpdate,
  type Settings,
  type TokenInfo,
  type UsageSummaryResult,
} from "../src/state/protocol";
import {
  activeEnvironment,
  connect,
  errorText,
  removeEnvironment,
  rpc,
  useApp,
} from "../src/state/runtime";
import {
  Button,
  ErrorBanner,
  Field,
  Group,
  Icon,
  Page,
  Row,
  T,
  Tap,
} from "../src/ui/primitives";
import { useTheme, type Appearance } from "../src/ui/theme";

const titles: Record<string, string> = {
  appearance: "Appearance",
  computers: "Computers",
  defaults: "Thread defaults",
  agents: "Agents",
  usage: "Usage",
  system: "Background & updates",
  access: "Access",
};
export default function SettingsDetail() {
  const { category = "appearance" } = useLocalSearchParams<{
    category: string;
  }>();
  const app = useApp();
  const { colors, appearance, setAppearance } = useTheme();
  const [loadedEnvironment, setLoadedEnvironment] = useState<string | null>(
    null,
  );
  const [settings, setSettings] = useState<Settings>();
  const [usage, setUsage] = useState<UsageSummaryResult>();
  const [activity, setActivity] = useState<DaemonActivity>();
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [updates, setUpdates] = useState<HarnessUpdate[]>([]);
  const [daemonUpdate, setDaemonUpdate] = useState<DaemonUpdate>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [section, setSection] = useState("");
  const [usageGroup, setUsageGroup] = useState<"provider" | "model" | "day">(
    "provider",
  );
  useEffect(() => {
    let alive = true;
    if (
      app.status !== "open" ||
      category === "appearance" ||
      category === "computers"
    )
      return;
    void Promise.all([
      rpc("settings.get", {}),
      category === "usage"
        ? rpc("usage.summary", { group_by: usageGroup })
        : Promise.resolve(undefined),
      category === "system"
        ? rpc("daemon.activity", {})
        : Promise.resolve(undefined),
    ])
      .then(([s, u, a]) => {
        if (alive) {
          setLoadedEnvironment(app.activeId);
          setSettings(s);
          setUsage(u);
          setActivity(a);
          setError("");
        }
      })
      .catch((e) => {
        if (alive) setError(errorText(e));
      });
    return () => {
      alive = false;
    };
  }, [app.status, app.activeId, usageGroup, category]);
  async function save(next: Settings) {
    setBusy(true);
    setError("");
    try {
      await rpc("settings.update", { settings: next });
      setSettings(next);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function access() {
    setSection(section === "access" ? "" : "access");
    try {
      const r = await rpc("access.tokens.list", {});
      setTokens(r.tokens);
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function loadUpdates() {
    setSection(section === "updates" ? "" : "updates");
    try {
      const [h, d] = await Promise.all([
        rpc("harness_updates.list", {}),
        rpc("daemon_update.status", {}),
      ]);
      setUpdates(h.updates);
      setDaemonUpdate(d);
    } catch (e) {
      setError(errorText(e));
    }
  }
  const toggle = (
    title: string,
    detail: string,
    key:
      | "worktrees_default"
      | "generate_titles"
      | "notifications"
      | "auto_update_harnesses"
      | "auto_update_daemon",
  ) =>
    settings && (
      <Row
        title={title}
        detail={detail}
        trailing={
          <Toggle
            accessibilityLabel={title}
            disabled={busy}
            value={settings[key]}
            onValueChange={(value) => void save({ ...settings, [key]: value })}
            trackColor={{ true: colors.accent }}
          />
        }
      />
    );
  return (
    <Page>
      <Stack.Screen options={{ title: titles[category] ?? "Settings" }} />
      {category === "appearance" && (
        <Group title="Appearance">
          <View
            style={{
              flexDirection: "row",
              padding: 4,
              borderRadius: 20,
              backgroundColor: colors.raised,
            }}
          >
            {(["system", "light", "dark"] as Appearance[]).map((value) => (
              <View key={value} style={{ flex: 1 }}>
                <Tap
                  label={`Use ${value} appearance`}
                  selected={value === appearance}
                  onPress={() => setAppearance(value)}
                  style={{
                    borderRadius: 16,
                    alignItems: "center",
                    backgroundColor:
                      value === appearance ? colors.surface : undefined,
                  }}
                >
                  <T variant="label">
                    {value.charAt(0).toUpperCase() + value.slice(1)}
                  </T>
                </Tap>
              </View>
            ))}
          </View>
          <T variant="caption" tone="secondary" style={{ marginTop: 12 }}>
            Ink · Clean whites and neutral charcoal.
          </T>
        </Group>
      )}
      {category === "computers" && (
        <Group title="Your computers">
          {app.environments.map((env) => (
            <View key={env.id} style={{ marginBottom: 8 }}>
              <Row
                title={env.name}
                detail={
                  env.id === app.activeId
                    ? app.status === "open"
                      ? "Connected"
                      : app.status
                    : env.url.replace(/^wss?:\/\//, "").replace(/\/ws$/, "")
                }
                icon="laptopcomputer"
                onPress={() => connect(env.id)}
                trailing={
                  env.id === app.activeId ? (
                    <Icon
                      name="checkmark.circle.fill"
                      size={18}
                      color={colors.accent}
                    />
                  ) : (
                    <Icon name="chevron.right" size={12} />
                  )
                }
              />
              <Tap
                label={`Forget ${env.name}`}
                onPress={() =>
                  Alert.alert(
                    `Forget ${env.name}?`,
                    "This removes the saved connection from this phone. Your projects and conversations stay on the computer.",
                    [
                      { text: "Cancel", style: "cancel" },
                      {
                        text: "Forget computer",
                        style: "destructive",
                        onPress: () => {
                          void removeEnvironment(env.id).catch((e) =>
                            setError(errorText(e)),
                          );
                        },
                      },
                    ],
                  )
                }
              >
                <T variant="caption" tone="secondary">
                  Forget connection
                </T>
              </Tap>
            </View>
          ))}
          <Row
            title="Connect a computer"
            icon="plus"
            onPress={() => router.push("/connect")}
          />
        </Group>
      )}
      <ErrorBanner error={error || app.error} />
      {app.status === "open" &&
        loadedEnvironment === app.activeId &&
        settings && (
          <>
            {category === "defaults" && (
              <Group
                title={`Defaults on ${activeEnvironment()?.name ?? "your computer"}`}
              >
                <Row
                  title="Default agent"
                  detail={
                    app.providers.find(
                      (p) => p.kind === settings.default_provider,
                    )?.display_name ?? settings.default_provider
                  }
                  onPress={() => setSection(section === "agent" ? "" : "agent")}
                />
                {section === "agent" &&
                  app.providers
                    .filter((p) => p.available)
                    .map((p) => (
                      <Row
                        key={p.kind}
                        title={p.display_name}
                        trailing={
                          p.kind === settings.default_provider ? (
                            <Icon name="checkmark" size={16} />
                          ) : undefined
                        }
                        onPress={() =>
                          void save({ ...settings, default_provider: p.kind })
                        }
                      />
                    ))}
                <Row
                  title="Default permissions"
                  detail={settings.default_permission_mode}
                  onPress={() =>
                    setSection(section === "permissions" ? "" : "permissions")
                  }
                />
                {section === "permissions" &&
                  (
                    app.providers.find(
                      (p) => p.kind === settings.default_provider,
                    )?.supported_permission_modes ?? []
                  ).map((mode) => (
                    <Row
                      key={mode}
                      title={mode}
                      trailing={
                        mode === settings.default_permission_mode ? (
                          <Icon name="checkmark" size={16} />
                        ) : undefined
                      }
                      onPress={() =>
                        void save({
                          ...settings,
                          default_permission_mode: mode,
                        })
                      }
                    />
                  ))}
                {toggle(
                  "Use worktrees by default",
                  "Give new threads their own checkout.",
                  "worktrees_default",
                )}
                {toggle(
                  "Generate thread titles",
                  "Let an agent name new conversations.",
                  "generate_titles",
                )}
                {toggle(
                  "Enable desktop notifications",
                  "Notify on the computer when work needs attention.",
                  "notifications",
                )}
              </Group>
            )}
            {category === "usage" && (
              <Group title="Usage">
                <Row
                  title="Total cost"
                  detail={`${usage?.total.turns ?? 0} turns`}
                  trailing={
                    <T
                      variant="heading"
                      style={{ fontVariant: ["tabular-nums"] }}
                    >
                      ${(usage?.total.cost_usd ?? 0).toFixed(2)}
                    </T>
                  }
                />
                <View style={{ flexDirection: "row", gap: 8 }}>
                  {(["provider", "model", "day"] as const).map((g) => (
                    <Tap
                      key={g}
                      label={`Group usage by ${g}`}
                      onPress={() => setUsageGroup(g)}
                      style={{
                        paddingHorizontal: 12,
                        borderRadius: 16,
                        backgroundColor:
                          usageGroup === g ? colors.raised : undefined,
                      }}
                    >
                      <T variant="caption" tone="secondary">
                        {g.charAt(0).toUpperCase() + g.slice(1)}
                      </T>
                    </Tap>
                  ))}
                </View>
                {usage?.rows.map((row) => (
                  <Row
                    key={row.key}
                    title={row.key}
                    detail={`${row.turns} turns · ${(row.usage.input_tokens + row.usage.output_tokens).toLocaleString()} tokens`}
                    trailing={
                      <T
                        variant="caption"
                        style={{ fontVariant: ["tabular-nums"] }}
                      >
                        ${row.cost_usd.toFixed(2)}
                      </T>
                    }
                  />
                ))}
              </Group>
            )}
            {category === "agents" && (
              <Group title="Agent configuration">
                {app.providers.map((provider) => (
                  <View key={provider.kind}>
                    <Row
                      title={provider.display_name}
                      detail={
                        provider.available
                          ? "Model, executable, and environment"
                          : (provider.unavailable_reason ?? "Not installed")
                      }
                      onPress={() =>
                        setSection(
                          section === provider.kind ? "" : provider.kind,
                        )
                      }
                    />
                    {section === provider.kind && (
                      <ProviderConfiguration
                        key={`${app.activeId}:${provider.kind}`}
                        value={settings.providers[provider.kind]}
                        busy={busy}
                        onSave={(value) =>
                          save({
                            ...settings,
                            providers: {
                              ...settings.providers,
                              [provider.kind]: value,
                            },
                          })
                        }
                      />
                    )}
                  </View>
                ))}
              </Group>
            )}
            {category === "system" && (
              <Group title="Computer resources">
                {activity && (
                  <T variant="caption" tone="secondary">
                    {activity.live_sessions} agent sessions ·{" "}
                    {activity.terminals} terminals · {activity.running_threads}{" "}
                    running threads
                  </T>
                )}
                <Row
                  title="Save power on battery"
                  detail="Release idle agents sooner and pause automatic updates."
                  trailing={
                    <Toggle
                      accessibilityLabel="Save power on battery"
                      disabled={busy}
                      value={settings.background.save_power_on_battery}
                      onValueChange={(v) =>
                        void save({
                          ...settings,
                          background: {
                            ...settings.background,
                            save_power_on_battery: v,
                          },
                        })
                      }
                      trackColor={{ true: colors.accent }}
                    />
                  }
                />
                <Row
                  title="Background limits"
                  detail="Control idle agent, terminal, and daemon lifetimes."
                  onPress={() =>
                    setSection(section === "background" ? "" : "background")
                  }
                />
                {section === "background" && (
                  <BackgroundLimits
                    settings={settings}
                    onSave={save}
                    busy={busy}
                  />
                )}
              </Group>
            )}
            {category === "system" && (
              <Group title="Updates">
                {toggle(
                  "Update agents automatically",
                  "Keep installed coding agents current.",
                  "auto_update_harnesses",
                )}
                {toggle(
                  "Update Kybern automatically",
                  "Install daemon updates when it is safe to restart.",
                  "auto_update_daemon",
                )}
                <Row
                  title="Check versions"
                  icon="arrow.clockwise"
                  onPress={() => void loadUpdates()}
                />
                {section === "updates" && (
                  <>
                    <Row
                      title="Kybern daemon"
                      detail={daemonUpdate?.message}
                      trailing={
                        <T variant="caption">{daemonUpdate?.current_version}</T>
                      }
                    />
                    <Button
                      secondary
                      onPress={() => {
                        void rpc("daemon_update.check", {})
                          .then(setDaemonUpdate)
                          .catch((e) => setError(errorText(e)));
                      }}
                    >
                      Check for an update
                    </Button>
                    {daemonUpdate?.status === "available" && (
                      <Button
                        onPress={() => {
                          void rpc("daemon_update.run", {})
                            .then(setDaemonUpdate)
                            .catch((e) => setError(errorText(e)));
                        }}
                      >
                        Update Kybern
                      </Button>
                    )}
                    {updates.map((update) => (
                      <Row
                        key={update.kind}
                        title={update.kind}
                        detail={update.message}
                        onPress={() => {
                          void rpc("harness_updates.run", { kind: update.kind })
                            .then((value) =>
                              setUpdates((prev) =>
                                prev.map((u) =>
                                  u.kind === value.kind ? value : u,
                                ),
                              ),
                            )
                            .catch((e) => setError(errorText(e)));
                        }}
                      />
                    ))}
                  </>
                )}
              </Group>
            )}
            {category === "access" && (
              <Group title="Access">
                <Row
                  title="Connect over Tailscale"
                  detail="Allow paired devices on your private Tailscale network."
                  trailing={
                    <Toggle
                      accessibilityLabel="Connect over Tailscale"
                      value={settings.access.tailscale}
                      onValueChange={(value) => {
                        setBusy(true);
                        void rpc("access.exposure.set", { tailscale: value })
                          .then(() => rpc("settings.get", {}))
                          .then(setSettings)
                          .catch((e) => setError(errorText(e)))
                          .finally(() => setBusy(false));
                      }}
                      disabled={busy}
                      trackColor={{ true: colors.accent }}
                    />
                  }
                />
                <Row
                  title="Paired devices"
                  icon="lock.shield"
                  onPress={() => void access()}
                />
                {section === "access" &&
                  tokens
                    .filter((t) => !t.revoked)
                    .map((token) => (
                      <Row
                        key={token.id}
                        title={token.label}
                        detail={
                          token.last_used_at
                            ? `Last used ${new Date(token.last_used_at).toLocaleDateString()}`
                            : "Not used yet"
                        }
                        onPress={() =>
                          Alert.alert(
                            `Revoke ${token.label}?`,
                            "This device will lose access until it pairs again.",
                            [
                              { text: "Cancel", style: "cancel" },
                              {
                                text: "Revoke access",
                                style: "destructive",
                                onPress: () => {
                                  void rpc("access.tokens.revoke", {
                                    token_id: token.id,
                                  })
                                    .then(() =>
                                      setTokens((ts) =>
                                        ts.filter((t) => t.id !== token.id),
                                      ),
                                    )
                                    .catch((e) => setError(errorText(e)));
                                },
                              },
                            ],
                          )
                        }
                      />
                    ))}
              </Group>
            )}
          </>
        )}
      {!["appearance", "computers"].includes(category) &&
        app.status !== "open" && (
          <Row
            title="Connect your computer"
            detail="Reconnect to change these settings."
            icon="laptopcomputer"
            onPress={() => router.push("/connect")}
          />
        )}
    </Page>
  );
}
function BackgroundLimits({
  settings,
  onSave,
  busy,
}: {
  settings: Settings;
  onSave: (settings: Settings) => Promise<void>;
  busy: boolean;
}) {
  const [values, setValues] = useState(settings.background);
  const [error, setError] = useState("");
  const keys = [
    ["session_idle_minutes", "Release idle agents after (minutes)"],
    ["max_idle_sessions", "Maximum idle agent sessions"],
    ["terminal_idle_minutes", "Close idle terminals after (minutes)"],
    ["daemon_idle_exit_minutes", "Stop idle daemon after (minutes)"],
  ] as const;
  return (
    <View style={{ gap: 16 }}>
      {keys.map(([key, label]) => (
        <Field
          key={key}
          label={label}
          value={String(values[key])}
          keyboardType="number-pad"
          onChangeText={(text) => {
            if (/^\d*$/.test(text))
              setValues((v) => ({ ...v, [key]: Number(text) }));
          }}
        />
      ))}
      <T variant="caption" tone="secondary">
        Use 0 to turn a limit off.
      </T>
      <ErrorBanner error={error} />
      <Button
        secondary
        busy={busy}
        onPress={() => {
          if (
            keys.some(
              ([key]) => !Number.isSafeInteger(values[key]) || values[key] < 0,
            )
          ) {
            setError("Enter a whole number of zero or more for each limit.");
            return;
          }
          void onSave({ ...settings, background: values });
        }}
      >
        Save limits
      </Button>
    </View>
  );
}

function ProviderConfiguration({
  value,
  busy,
  onSave,
}: {
  value: Settings["providers"][keyof Settings["providers"]];
  busy: boolean;
  onSave: (
    value: NonNullable<Settings["providers"][keyof Settings["providers"]]>,
  ) => Promise<void>;
}) {
  const [binary, setBinary] = useState(value?.binary ?? "");
  const [model, setModel] = useState(value?.model ?? "");
  const [environment, setEnvironment] = useState(
    JSON.stringify(value?.env ?? {}, null, 2),
  );
  const [error, setError] = useState("");
  return (
    <View style={{ gap: 16, paddingVertical: 12 }}>
      <Field
        label="Executable path"
        placeholder="Use the installed agent"
        autoCapitalize="none"
        autoCorrect={false}
        value={binary}
        onChangeText={setBinary}
      />
      <Field
        label="Default model"
        placeholder="Use the agent default"
        autoCapitalize="none"
        autoCorrect={false}
        value={model}
        onChangeText={setModel}
      />
      <Field
        label="Environment variables (JSON)"
        autoCapitalize="none"
        autoCorrect={false}
        multiline
        value={environment}
        onChangeText={setEnvironment}
      />
      <ErrorBanner error={error} />
      <Button
        secondary
        busy={busy}
        onPress={() => {
          try {
            const env: unknown = JSON.parse(environment);
            if (
              !env ||
              typeof env !== "object" ||
              Array.isArray(env) ||
              Object.values(env).some((v) => typeof v !== "string")
            )
              throw new Error(
                "Use a JSON object with a string value for each environment variable.",
              );
            setError("");
            void onSave({
              binary: binary.trim() || null,
              model: model.trim() || null,
              env: env as Record<string, string>,
            });
          } catch (e) {
            setError(errorText(e));
          }
        }}
      >
        Save agent configuration
      </Button>
    </View>
  );
}
