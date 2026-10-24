import { useState, type ReactNode } from "react";
import { Keyboard, Pressable, ScrollView, View } from "react-native";
import Animated, { useReducedMotion } from "react-native-reanimated";
import { CSS_EASE_OUT, DURATION } from "../components/liquid/motion";
import type { IconName } from "../ui/icons";
import Svg, { Circle } from "react-native-svg";
import { router } from "expo-router";
import { setDraft, useDraft } from "../state/draft";
import type { CoordinatorSwitchHarnessParams, PermissionMode, ProviderStatus, Thread } from "../state/protocol";
import { coordinatorEditsEnforced } from "../../../../packages/kybern-client/src/coordinator";
import { PROVIDER_DISPLAY_NAME } from "../state/protocol";
import {
  errorText,
  loadThread,
  refresh,
  rpc,
  useApp,
  useThreadValue,
} from "../state/runtime";
import { Icon, T, Tap, styles, ErrorBanner } from "../ui/primitives";
import { InsetGroup, ListRow, SectionFooter, SectionHeader } from "../ui/List";
import { SearchField } from "../ui/Search";
import { Toggle } from "../ui/Toggle";
import { showToast } from "../ui/Toast";
import type { MenuItem } from "../ui/menuModel";
import { ProviderMark } from "../ui/ProviderMark";
import { useLayout } from "../state/layout";
import { radius, space, useTheme } from "../ui/theme";
import type { ThreadState } from "../state/transcript";
import {
  backendLabel,
  catalogBackends,
  changeTrait,
  findModel,
  modelChoices,
  parameterSwitch,
  selectedVariant,
  traitUnavailableReason,
  traitValues,
  triggerTraits,
} from "../../../../packages/kybern-client/src/models";
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
function permissionChoices(kind: string, sessionId?: string | null) {
  if (kind !== "cursor" || (sessionId && !sessionId.startsWith("cursor-sdk:"))) return modes;
  return modes.filter((m) => m.value === "auto" || m.value === "full-access").map((m) => m.value === "auto"
    ? { ...m, label: "Auto-review", detail: "Run in Cursor’s sandbox with automatic review; no approval prompts." }
    : { ...m, detail: "Disable Cursor’s sandbox and automatic review." });
}
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
  const selectedModel = findModel(provider?.models ?? [], model);
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
  const traits = triggerTraits(selectedModel, model);
  const traitLabel = [traits.fast ? "Fast" : null, ...traits.labels].filter(Boolean).join(" · ");
  const compactModel = modelLabel.replace(/^GPT[- ]?/i, "");
  const permissionLabel =
    permissionChoices(kind, thread?.provider_session_id).find((item) => item.value === mode)?.label ?? mode;
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
      {/* Context only when it matters (≥ 50 %), with its number: a bare ring at low
          usage read as an activity spinner (ux-thread H10). */}
      {thread && fraction >= 0.5 && (
        <Tap
          label={`Context ${Math.round(fraction * 100)} percent used. Open usage`}
          disabled={disabled}
          onPress={() => openOptions("usage")}
          style={{ flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: space.xs }}
        >
          <Svg width={18} height={18} viewBox="0 0 20 20">
            <Circle cx={10} cy={10} r={7.5} stroke={colors.line} strokeWidth={2.5} fill="none" />
            <Circle
              cx={10}
              cy={10}
              r={7.5}
              stroke={fraction >= 0.85 ? colors.warning : colors.secondary}
              strokeWidth={2.5}
              fill="none"
              strokeLinecap="round"
              strokeDasharray={`${fraction * 47.124} 47.124`}
              rotation={-90}
              origin="10, 10"
            />
          </Svg>
          <T variant="caption" tone={fraction >= 0.85 ? "warning" : "secondary"} style={{ fontVariant: ["tabular-nums"] }}>
            {Math.round(fraction * 100)}%
          </T>
        </Tap>
      )}
      {/* On tablet the model chip sits at the trailing edge next to Send; on the
          phone it fills the middle. */}
      {regular && <View style={{ flex: 1 }} />}
      <Tap
        label={`${modelLabel}${effort ? `, ${effort} effort` : ""}${traitLabel ? `, ${traitLabel}` : ""}. Change model and reasoning`}
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
        <T variant="footnote" numberOfLines={1} style={{ flexShrink: 1 }}>
          {compactModel}
          {effortLabel || traitLabel ? (
            <T variant="footnote" tone="secondary">
              {" "}
              {[effortLabel, traitLabel].filter(Boolean).join(" · ")}
            </T>
          ) : null}
        </T>
      </Tap>
      {trailing}
    </View>
  );
}

/** "Default", "Work": an account instance as a row value. */
const accountLabel = (instance: string) =>
  instance === "default" ? "Default" : instance.charAt(0).toUpperCase() + instance.slice(1);
const effortWord = (effort: string | null | undefined) =>
  effort ? effort.charAt(0).toUpperCase() + effort.slice(1) : "Default";

/**
 * The Agent & model sheet (user review: `user-screens/12.png`). A grouped sheet:
 * the agent, account, effort and model traits as value rows that open menus, then
 * the model list as selectable rows with descriptions and a checkmark, a search
 * field, and a custom model ID as the secondary last row. Permissions and Usage
 * use the same rows.
 */
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
  const instance = thread?.provider.instance ?? draft.instance ?? "default";
  const provider = app.providers.find((p) => p.kind === kind);
  const model = thread ? thread.model : draft.model;
  const effort = thread ? thread.effort : draft.effort;
  const mode = thread?.permission_mode ?? draft.permission;
  const selectedModel = findModel(provider?.models ?? [], model);
  const context = usage?.context;
  const fraction =
    context && context.window_tokens > 0
      ? Math.min(1, context.used_tokens / context.window_tokens)
      : 0;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [modelQuery, setModelQuery] = useState("");
  const coordinator = !!thread?.coordinator_project_id;
  const idle = !thread || thread.status === "idle" || thread.status === "failed";
  // A provider subagent's harness and model belong to its parent.
  const canSwitchAgent = !thread?.subagent && idle;
  const { models: visibleModels, customId } = modelChoices(provider?.models ?? [], model, modelQuery);
  // One harness can route the same model name through several backends.
  const multiBackend = catalogBackends(provider?.models ?? []).length > 1;
  const efforts = [
    "",
    ...((selectedVariant(selectedModel, model)?.efforts?.length
      ? selectedVariant(selectedModel, model)!.efforts
      : selectedModel?.efforts) ??
      provider?.supported_efforts ??
      []),
  ];
  const traits = selectedModel?.parameters ?? [];
  const values = traitValues(selectedModel, model);

  async function act(work: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await work();
      return true;
    } catch (cause) {
      setError(errorText(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function switchCoordinator(request: Omit<CoordinatorSwitchHarnessParams, "project_id">) {
    if (!thread?.coordinator_project_id || !idle) throw new Error("Finish or stop the current turn before changing the Coordinator’s harness.");
    await rpc("coordinator.switch_harness", { project_id: thread.coordinator_project_id, ...request });
    await Promise.all([refresh(), loadThread(thread.id)]);
  }
  /** Agent or account for this thread or the next new chat (parity P1-10). */
  async function chooseTarget(next: ProviderStatus, nextInstance?: string) {
    const inst = nextInstance ?? (next.instances.includes("default") ? "default" : next.instances[0] ?? "default");
    if (next.kind === kind && inst === instance) return;
    const permission = next.supported_permission_modes.includes(mode) ? mode : next.supported_permission_modes[0] ?? "supervised";
    if (!thread) {
      setDraft({ provider: next.kind, instance: inst, ...(next.kind !== kind ? { model: "", effort: "" } : {}), permission });
      setModelQuery("");
      return;
    }
    await act(async () => {
      if (coordinator) await switchCoordinator({ provider: { kind: next.kind, instance: inst }, permission_mode: permission });
      else {
        await rpc("threads.target.set", {
          thread_id: thread.id,
          target: { provider: { kind: next.kind, instance: inst }, ...(next.kind === kind ? { model, effort } : {}) },
          inherit_account: false,
        });
        await Promise.all([refresh(), loadThread(thread.id)]);
      }
      showToast(next.kind === kind ? `Using the ${accountLabel(inst)} account` : `Switched to ${next.display_name}`);
    });
    setModelQuery("");
  }
  async function update(patch: { model?: string; effort?: string; permission_mode?: PermissionMode }) {
    if (!thread) {
      setDraft({
        ...(patch.model !== undefined ? { model: patch.model } : {}),
        ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
        ...(patch.permission_mode ? { permission: patch.permission_mode } : {}),
      });
      return true;
    }
    return act(async () => {
      if (thread.coordinator_project_id && (patch.model !== undefined || patch.effort !== undefined)) {
        const nextModel = patch.model !== undefined ? patch.model || undefined : thread.model || undefined;
        const nextEffort = patch.effort !== undefined ? patch.effort || undefined : patch.model !== undefined ? undefined : thread.effort || undefined;
        await switchCoordinator({
          provider: thread.provider,
          ...(nextModel ? { model: nextModel } : {}),
          ...(nextEffort ? { effort: nextEffort } : {}),
          permission_mode: thread.permission_mode,
        });
      } else {
        await rpc("threads.update", { thread_id: thread.id, ...patch });
        await Promise.all([refresh(), loadThread(thread.id)]);
      }
    });
  }
  const chooseModel = (id: string, defaultEffort?: string | null, custom?: boolean) =>
    void update({
      model: id,
      ...(!custom && (!thread || provider?.supports_effort_switch) ? { effort: defaultEffort ?? "" } : {}),
    }).then((saved) => {
      if (saved && custom) {
        setModelQuery("");
        Keyboard.dismiss();
      }
    });
  const agentItems: MenuItem[] = app.providers
    .filter((p) => p.available)
    .map((p) => ({
      title: p.display_name,
      checked: p.kind === kind,
      subtitle: coordinator
        ? coordinatorEditsEnforced(p.kind)
          ? "Can't edit files; delegates edits"
          : `Edits not blocked on ${p.display_name}`
        : undefined,
      onPress: () => void chooseTarget(p),
    }));
  const accounts = provider?.instances ?? [];
  const selectedModelId = selectedModel?.id ?? model ?? "";

  if (open === "permissions")
    return (
      <Sheet>
        <ErrorBanner error={error} />
        <InsetGroup>
          {permissionChoices(kind, thread?.provider_session_id)
            .filter((m) => (kind === "cursor" && !!thread?.provider_session_id && !thread.provider_session_id.startsWith("cursor-sdk:")) || provider?.supported_permission_modes.includes(m.value))
            .map((m) => (
              <ListRow
                key={m.value}
                title={m.label}
                subtitle={m.detail}
                leading={m.value === "full-access" ? <Icon name="lock.open" size={20} color={colors.warning} /> : "lock.shield"}
                checked={mode === m.value}
                disabled={busy}
                onPress={() => void update({ permission_mode: m.value }).then((saved) => saved && router.back())}
              />
            ))}
        </InsetGroup>
        <SectionFooter inset>
          {thread ? "Applies from the agent's next action in this thread." : "Applies to the next chat you start."}
        </SectionFooter>
      </Sheet>
    );

  if (open === "usage")
    return (
      <Sheet>
        <ErrorBanner error={error} />
        <SectionHeader title="Context" inset first />
        <InsetGroup>
          <ListRow
            title={context ? `${Math.round(fraction * 100)}% used` : "Not reported yet"}
            subtitle={
              context
                ? `${context.used_tokens.toLocaleString()} of ${context.window_tokens.toLocaleString()} tokens`
                : "The agent reports its context window after its first turn."
            }
          />
          {thread ? (
            <ListRow
              title="Compact conversation"
              subtitle="Summarize earlier turns to free context"
              leading="arrow.down.right.and.arrow.up.left"
              disabled={busy || !idle}
              onPress={() =>
                void act(async () => {
                  await rpc("threads.compact", { thread_id: thread.id });
                  await loadThread(thread.id);
                  showToast("Compacting the conversation");
                })
              }
            />
          ) : null}
        </InsetGroup>
        {usage?.limits?.length ? (
          <>
            <SectionHeader title="Plan limits" inset />
            <InsetGroup>
              {usage.limits.map((l) => (
                <ListRow
                  key={l.name}
                  title={l.name}
                  value={`${Math.round(l.used_percent)}%`}
                  subtitle={l.resets_at ? `Resets ${new Date(l.resets_at * 1000).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}` : undefined}
                />
              ))}
            </InsetGroup>
          </>
        ) : null}
      </Sheet>
    );

  return (
    <Sheet>
      <ErrorBanner error={error} />
      <InsetGroup>
        <ListRow
          title="Agent"
          leading={<ProviderMark kind={kind} size={22} />}
          value={provider?.display_name ?? PROVIDER_DISPLAY_NAME[kind]}
          valueMenu={canSwitchAgent && agentItems.length > 1 ? agentItems : undefined}
          disabled={busy}
        />
        {accounts.length > 1 && (
          <ListRow
            title="Account"
            leading="person.crop.circle"
            value={accountLabel(instance)}
            valueMenu={
              canSwitchAgent
                ? accounts.map((item) => ({
                    title: accountLabel(item),
                    checked: item === instance,
                    onPress: () => void chooseTarget(provider!, item),
                  }))
                : undefined
            }
            disabled={busy}
          />
        )}
        {efforts.length > 1 && (
          <ListRow
            title="Reasoning effort"
            leading="sparkles"
            value={effortWord(effort)}
            valueMenu={efforts.map((e) => ({
              title: effortWord(e),
              checked: (effort ?? "") === e,
              onPress: () => void update({ effort: e }),
            }))}
            disabled={busy}
          />
        )}
        {traits.map((parameter) => {
          const toggle = parameterSwitch(parameter);
          const value = values[parameter.id] ?? parameter.default;
          const choose = (next: string) => {
            const variant = selectedModel ? changeTrait(selectedModel, model, parameter.id, next) : undefined;
            if (variant) void update({ model: variant.id });
          };
          if (toggle) {
            const reason = traitUnavailableReason(selectedModel!, model, parameter.id, value === toggle.on ? toggle.off : toggle.on);
            return (
              <ListRow
                key={parameter.id}
                title={parameter.label}
                subtitle={reason ?? undefined}
                leading="square.stack.3d.up"
                trailing={
                  <Toggle
                    value={value === toggle.on}
                    disabled={busy || !!reason}
                    accessibilityLabel={parameter.label}
                    onValueChange={(on) => choose(on ? toggle.on : toggle.off)}
                  />
                }
              />
            );
          }
          return (
            <ListRow
              key={parameter.id}
              title={parameter.label}
              leading="square.stack.3d.up"
              value={parameter.values.find((item) => item.value === value)?.label ?? value}
              valueMenu={parameter.values.map((item) => {
                const reason = traitUnavailableReason(selectedModel!, model, parameter.id, item.value);
                return {
                  title: item.label,
                  checked: item.value === value,
                  disabled: !!reason,
                  subtitle: reason ?? undefined,
                  onPress: () => choose(item.value),
                };
              })}
              disabled={busy}
            />
          );
        })}
      </InsetGroup>
      {(thread?.subagent || (thread && !idle)) && (
        <SectionFooter inset>
          {thread.subagent
            ? "A subagent uses its parent's agent and account."
            : "Finish or stop the current turn to switch agents or accounts."}
        </SectionFooter>
      )}
      <SectionHeader title="Model" inset />
      <View style={{ gap: space.sm }}>
        <SearchField
          value={modelQuery}
          onChangeText={setModelQuery}
          placeholder="Search models"
          fill={colors.surface}
          onSubmit={() => customId && !visibleModels.length && chooseModel(customId, null, true)}
        />
        {visibleModels.length > 0 && (
          <InsetGroup>
            {visibleModels.map((m) => (
              <ListRow
                key={m.id || "default"}
                title={m.display_name}
                subtitle={
                  [multiBackend && m.provider ? backendLabel(m.provider) : null, m.id ? m.description : `${provider?.display_name ?? "The agent"} picks its own default`, m.custom ? "Custom model ID" : null]
                    .filter(Boolean)
                    .join(" · ") || undefined
                }
                checked={selectedModelId === m.id}
                disabled={busy}
                onPress={() => chooseModel(m.id, m.default_effort, m.custom)}
              />
            ))}
          </InsetGroup>
        )}
        {customId && (
          <InsetGroup>
            <ListRow
              title={`Use “${customId}”`}
              mono
              subtitle="Custom model ID"
              leading="plus"
              disabled={busy}
              onPress={() => chooseModel(customId, null, true)}
            />
          </InsetGroup>
        )}
      </View>
      <SectionFooter inset>
        {customId || modelQuery ? "Enter an exact ID to use a model that isn't listed." : "Search, or type an exact model ID."}
      </SectionFooter>
      {coordinator && (
        <SectionFooter inset>
          {idle ? "Changing harnesses keeps this conversation and its agents." : "Finish or stop the current turn before changing the Coordinator’s harness."}
        </SectionFooter>
      )}
    </Sheet>
  );
}

/** The sheet body: a grouped page. */
function Sheet({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      style={{ flex: 1, backgroundColor: colors.grouped }}
      contentContainerStyle={{ paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space["3xl"] }}
    >
      {children}
    </ScrollView>
  );
}

/**
 * The composer's send control (ux-thread M4). Empty: a quiet `raised` disc with a
 * muted arrow (it is not a dimmed primary). Ready: `ink` with an `inverse` arrow.
 * Running with nothing typed: Stop. The fill cross-fades in 120 ms.
 */
export function SendButton({
  state,
  icon,
  label,
  onPress,
  disabled,
}: {
  state: "empty" | "ready" | "stop";
  icon: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const on = state !== "empty";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
    >
      {({ pressed }) => (
        <Animated.View
          style={{
            width: 34,
            height: 34,
            borderRadius: radius.full,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: on ? colors.ink : colors.raised,
            opacity: disabled && on ? 0.6 : 1,
            transform: [{ scale: pressed && !reduced ? 0.94 : 1 }],
            transitionProperty: ["backgroundColor", "transform", "opacity"],
            transitionDuration: DURATION.press,
            transitionTimingFunction: CSS_EASE_OUT,
          }}
        >
          <Icon
            name={state === "stop" ? "stop.fill" : icon}
            size={state === "stop" ? 14 : 18}
            color={on ? colors.inverse : colors.muted}
          />
        </Animated.View>
      )}
    </Pressable>
  );
}
