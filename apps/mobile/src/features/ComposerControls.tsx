import { useState, type ReactNode } from "react";
import { Keyboard, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { router } from "expo-router";
import { setDraft, useDraft } from "../state/draft";
import type { PermissionMode, Thread } from "../state/protocol";
import { PROVIDER_DISPLAY_NAME } from "../state/protocol";
import {
  errorText,
  loadThread,
  refresh,
  rpc,
  useApp,
  useThreadValue,
} from "../state/runtime";
import {
  Icon,
  T,
  Tap,
  styles,
  ErrorBanner,
  Page,
  Group,
  Field,
} from "../ui/primitives";
import { ProviderMark } from "../ui/ProviderMark";
import { useLayout } from "../state/layout";
import { useTheme } from "../ui/theme";
import type { ThreadState } from "../state/transcript";
import { modelChoices } from "../../../../packages/kybern-client/src/models";
const selectUsage = (state: ThreadState) => state.providerUsage;

const modes: { value: PermissionMode; label: string; detail: string }[] = [
  {
    value: "supervised",
    label: "Ask before acting",
    detail: "Review commands and edits before they run.",
  },
  {
    value: "accept-edits",
    label: "Allow edits",
    detail: "Allow file edits; ask before running commands.",
  },
  {
    value: "auto",
    label: "Automatic",
    detail: "Let the agent decide when to ask.",
  },
  {
    value: "full-access",
    label: "Full access",
    detail: "Allow commands and edits without asking.",
  },
];
export function ComposerControls({
  thread,
  disabled,
  leading,
  trailing,
}: {
  thread?: Thread | null;
  disabled?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  const app = useApp();
  const draft = useDraft();
  const usage = useThreadValue(thread?.id ?? "", selectUsage);
  const { colors } = useTheme();
  const kind = thread?.provider.kind ?? draft.provider;
  const provider = app.providers.find((p) => p.kind === kind);
  const model = thread ? thread.model : draft.model;
  const effort = thread ? thread.effort : draft.effort;
  const mode = thread?.permission_mode ?? draft.permission;
  const selectedModel = provider?.models?.find((m) => m.id === model);
  const modelLabel =
    selectedModel?.display_name || model || PROVIDER_DISPLAY_NAME[kind];
  const context = usage?.context;
  const fraction =
    context && context.window_tokens > 0
      ? Math.max(0, Math.min(1, context.used_tokens / context.window_tokens))
      : 0;
  const effortLabel = effort
    ? effort.charAt(0).toUpperCase() + effort.slice(1)
    : "";
  const compactModel = modelLabel.replace(/^GPT[- ]?/i, "");
  const permissionLabel =
    modes.find((item) => item.value === mode)?.label ?? mode;
  const { regular } = useLayout();
  function openOptions(section: "model" | "permissions" | "usage") {
    router.push({
      pathname: "/composer-options",
      params: { section, ...(thread ? { threadId: thread.id } : {}) },
    });
  }
  return (
    <View style={[styles.line, { gap: 0 }]}>
      {leading}
      <Tap
        label={`Permissions: ${permissionLabel}`}
        disabled={disabled}
        onPress={() => openOptions("permissions")}
        style={{ width: 44, alignItems: "center" }}
      >
        <Icon
          name="lock.shield"
          size={19}
          color={mode === "full-access" ? colors.warning : colors.secondary}
        />
      </Tap>
      <View style={{ width: 8 }} />
      {thread && (
        <Tap
          label={
            context
              ? `Context usage: ${Math.round(fraction * 100)} percent`
              : "Context usage unavailable"
          }
          disabled={disabled}
          onPress={() => openOptions("usage")}
          style={{ width: 44, alignItems: "center" }}
        >
          <Svg width={20} height={20} viewBox="0 0 20 20">
            <Circle
              cx={10}
              cy={10}
              r={7.5}
              stroke={colors.line}
              strokeWidth={2.5}
              fill="none"
            />
            {fraction > 0 && (
              <Circle
                cx={10}
                cy={10}
                r={7.5}
                stroke={fraction >= 0.85 ? colors.warning : colors.ink}
                strokeWidth={2.5}
                fill="none"
                strokeLinecap="round"
                strokeDasharray={`${fraction * 47.124} 47.124`}
                rotation={-90}
                origin="10, 10"
              />
            )}
          </Svg>
        </Tap>
      )}
      {/* On tablet the model chip sits at the trailing edge next to Send; on the
          phone it fills the middle. */}
      {regular && <View style={{ flex: 1 }} />}
      <Tap
        label={`${modelLabel}${effort ? `, ${effort} effort` : ""}. Change model and reasoning`}
        disabled={disabled}
        onPress={() => openOptions("model")}
        style={[
          styles.line,
          {
            minWidth: 0,
            paddingHorizontal: 8,
            gap: 6,
            ...(regular ? { flexShrink: 1 } : { flex: 1 }),
          },
        ]}
      >
        <ProviderMark kind={kind} size={16} />
        <T variant="caption" numberOfLines={1} style={{ flexShrink: 1 }}>
          {compactModel}
          {effortLabel ? (
            <T variant="caption" tone="secondary">
              {" "}
              {effortLabel}
            </T>
          ) : null}
        </T>
      </Tap>
      {trailing}
    </View>
  );
}

export function ComposerOptions({
  thread,
  section: open,
}: {
  thread?: Thread | null;
  section: "permissions" | "model" | "usage";
}) {
  const app = useApp();
  const draft = useDraft();
  const usage = useThreadValue(thread?.id ?? "", selectUsage);
  const { colors } = useTheme();
  const kind = thread?.provider.kind ?? draft.provider;
  const provider = app.providers.find((p) => p.kind === kind);
  const model = thread ? thread.model : draft.model;
  const effort = thread ? thread.effort : draft.effort;
  const mode = thread?.permission_mode ?? draft.permission;
  const selectedModel = provider?.models?.find((m) => m.id === model);
  const context = usage?.context;
  const fraction =
    context && context.window_tokens > 0
      ? Math.min(1, context.used_tokens / context.window_tokens)
      : 0;
  const [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState<"agent" | "effort" | null>(null);
  const [error, setError] = useState("");
  const [modelQuery, setModelQuery] = useState("");
  const { models: visibleModels, customId } = modelChoices(
    provider?.models ?? [],
    model,
    modelQuery,
  );
  async function update(patch: {
    model?: string;
    effort?: string;
    permission_mode?: PermissionMode;
  }) {
    setBusy(true);
    setError("");
    try {
      if (thread) {
        await rpc("threads.update", { thread_id: thread.id, ...patch });
        await Promise.all([refresh(), loadThread(thread.id)]);
      } else
        setDraft({
          ...(patch.model !== undefined ? { model: patch.model } : {}),
          ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
          ...(patch.permission_mode
            ? { permission: patch.permission_mode }
            : {}),
        });
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <Page>
      <ErrorBanner error={error} />
      {open === "permissions" &&
        modes
          .filter((m) => provider?.supported_permission_modes.includes(m.value))
          .map((m) => (
            <Tap
              key={m.value}
              label={m.label}
              selected={mode === m.value}
              disabled={busy}
              onPress={() => {
                void update({ permission_mode: m.value }).then((saved) => {
                  if (saved) router.back();
                });
              }}
              style={[
                styles.spread,
                {
                  padding: 16,
                  marginBottom: 8,
                  borderRadius: 20,
                  backgroundColor:
                    mode === m.value ? colors.accentSoft : colors.raised,
                },
              ]}
            >
              <View style={{ flex: 1, gap: 5 }}>
                <T variant="label">{m.label}</T>
                <T variant="caption" tone="secondary">
                  {m.detail}
                </T>
              </View>
              {mode === m.value && <Icon name="checkmark" size={14} />}
            </Tap>
          ))}
      {open === "model" && (
        <>
          <View
            style={{
              borderRadius: 18,
              backgroundColor: colors.surface,
              paddingHorizontal: 16,
              marginBottom: 20,
            }}
          >
            {thread ? (
              <View style={[styles.line, { minHeight: 54 }]}>
                <ProviderMark kind={kind} size={22} />
                <T style={{ flex: 1 }}>{provider?.display_name ?? kind}</T>
              </View>
            ) : (
              <>
                <Tap
                  label="Choose agent"
                  disabled={!!thread}
                  onPress={() =>
                    setChoosing(choosing === "agent" ? null : "agent")
                  }
                  style={[styles.line, { minHeight: 54 }]}
                >
                  <ProviderMark kind={kind} size={22} />
                  <T style={{ flex: 1 }}>{provider?.display_name ?? kind}</T>
                  {!thread && <Icon name="chevron.down" size={12} />}
                </Tap>
              </>
            )}
            <View style={{ height: 1, backgroundColor: colors.line }} />
            <Tap
              label={`Reasoning effort: ${effort || "Default"}`}
              onPress={() =>
                setChoosing(choosing === "effort" ? null : "effort")
              }
              style={[styles.spread, { minHeight: 50 }]}
            >
              <T variant="caption" tone="secondary">
                Reasoning effort
              </T>
              <View style={styles.line}>
                <T variant="caption" style={{ textTransform: "capitalize" }}>
                  {effort || "Default"}
                </T>
                <Icon name="chevron.down" size={12} />
              </View>
            </Tap>
          </View>
          {choosing === "agent" && (
            <Group title="Choose an agent">
              <View
                style={{ borderRadius: 18, backgroundColor: colors.surface }}
              >
                {app.providers
                  .filter((p) => p.available)
                  .map((p) => (
                    <Tap
                      key={p.kind}
                      label={`Use ${p.display_name}`}
                      selected={kind === p.kind}
                      onPress={() => {
                        setModelQuery("");
                        setDraft({
                          provider: p.kind,
                          instance: p.instances[0] ?? "default",
                          model: "",
                          effort: "",
                          permission: p.supported_permission_modes.includes(
                            mode,
                          )
                            ? mode
                            : (p.supported_permission_modes[0] ?? "supervised"),
                        });
                        setChoosing(null);
                      }}
                      style={[
                        styles.line,
                        { paddingHorizontal: 16, minHeight: 54 },
                      ]}
                    >
                      <ProviderMark kind={p.kind} size={22} />
                      <T style={{ flex: 1 }}>{p.display_name}</T>
                      {kind === p.kind && <Icon name="checkmark" size={16} />}
                    </Tap>
                  ))}
              </View>
            </Group>
          )}
          {choosing === "effort" && (
            <Group title="Choose reasoning effort">
              <View
                style={{ borderRadius: 18, backgroundColor: colors.surface }}
              >
                {[
                  "",
                  ...(selectedModel?.efforts ??
                    provider?.supported_efforts ??
                    []),
                ].map((e) => (
                  <Tap
                    key={e}
                    label={e || "Default effort"}
                    selected={(effort ?? "") === e}
                    disabled={busy}
                    onPress={() =>
                      void update({ effort: e }).then((saved) => {
                        if (saved) setChoosing(null);
                      })
                    }
                    style={[
                      styles.spread,
                      { paddingHorizontal: 16, minHeight: 50 },
                    ]}
                  >
                    <T style={{ textTransform: "capitalize" }}>
                      {e || "Default"}
                    </T>
                    {(effort ?? "") === e && (
                      <Icon name="checkmark" size={16} />
                    )}
                  </Tap>
                ))}
              </View>
            </Group>
          )}
          {!choosing && (
            <View>
              <Group title="Choose a model">
                <Field
                  label="Find or enter a model"
                  placeholder="Search models or enter an exact ID"
                  value={modelQuery}
                  onChangeText={setModelQuery}
                  autoCapitalize="none"
                  autoCorrect={false}
                  clearButtonMode="while-editing"
                  returnKeyType="search"
                />
                {!visibleModels.length && !customId && (
                  <T
                    variant="caption"
                    tone="secondary"
                    style={{ paddingVertical: 12 }}
                  >
                    No models match your search.
                  </T>
                )}
                <View
                  style={{
                    backgroundColor: colors.surface,
                    borderRadius: 18,
                    overflow: "hidden",
                  }}
                >
                  {visibleModels.map((m) => (
                    <Tap
                      key={m.id}
                      label={m.display_name}
                      disabled={busy}
                      selected={(model ?? "") === m.id}
                      onPress={() =>
                        void update({
                          model: m.id,
                          ...(!m.custom &&
                          (!thread || provider?.supports_effort_switch)
                            ? { effort: m.default_effort ?? "" }
                            : {}),
                        })
                      }
                      style={[
                        styles.spread,
                        {
                          paddingHorizontal: 16,
                          paddingVertical: 12,
                          minHeight: 52,
                          borderBottomWidth: 0.5,
                          borderColor: colors.line,
                        },
                      ]}
                    >
                      <T variant="label" style={{ flex: 1 }}>
                        {m.display_name}
                      </T>
                      {(model ?? "") === m.id && (
                        <Icon name="checkmark" size={12} />
                      )}
                    </Tap>
                  ))}
                  {customId && (
                    <Tap
                      label={`Use ${customId}`}
                      disabled={busy}
                      onPress={() => {
                        void update({ model: customId }).then((saved) => {
                          if (saved) {
                            setModelQuery("");
                            Keyboard.dismiss();
                          }
                        });
                      }}
                      style={[styles.spread, { padding: 16, minHeight: 52 }]}
                    >
                      <View style={{ flex: 1, gap: 3 }}>
                        <T variant="label">Use “{customId}”</T>
                        <T variant="caption" tone="secondary">
                          Custom model ID
                        </T>
                      </View>
                      <Icon name="plus" size={16} />
                    </Tap>
                  )}
                </View>
              </Group>
            </View>
          )}
        </>
      )}
      {open === "usage" && (
        <>
          <T variant="caption" selectable>
            {context
              ? `${context.used_tokens.toLocaleString()} / ${context.window_tokens.toLocaleString()} tokens · ${Math.round(fraction * 100)}% used`
              : "The agent has not reported its context window yet."}
          </T>
          {usage?.limits?.map((l) => (
            <View key={l.name} style={{ paddingVertical: 6 }}>
              <T variant="label">
                {l.name} · {Math.round(l.used_percent)}% used
              </T>
              {l.resets_at && (
                <T variant="caption" tone="secondary">
                  Resets {new Date(l.resets_at * 1000).toLocaleString()}
                </T>
              )}
            </View>
          ))}
          {thread && (
            <Tap
              label="Compact conversation"
              disabled={
                busy ||
                thread.status === "running" ||
                thread.status === "awaiting-approval"
              }
              onPress={() => {
                setBusy(true);
                void rpc("threads.compact", { thread_id: thread.id })
                  .then(() => loadThread(thread.id))
                  .catch((e) => setError(errorText(e)))
                  .finally(() => setBusy(false));
              }}
            >
              <T variant="label" tone="accent">
                Compact conversation
              </T>
            </Tap>
          )}
        </>
      )}
    </Page>
  );
}
