import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { Toggle } from "../src/ui/Toggle";
import { getDraft, setDraft, type DraftOptions } from "../src/state/draft";
import {
  type BranchInfo,
  type PermissionMode,
  type ProviderKind,
} from "../src/state/protocol";
import {
  errorText,
  loadThread,
  refresh,
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
  styles,
} from "../src/ui/primitives";
import { ProviderMark } from "../src/ui/ProviderMark";
import { useTheme } from "../src/ui/theme";
import { modelChoices } from "../../../packages/kybern-client/src/models";

const permissions: { value: PermissionMode; title: string; detail: string }[] =
  [
    {
      value: "supervised",
      title: "Ask before acting",
      detail: "Review commands and edits before they run.",
    },
    {
      value: "accept-edits",
      title: "Allow edits",
      detail: "Approve file edits automatically; ask about commands.",
    },
    {
      value: "auto",
      title: "Automatic",
      detail: "Let the agent choose when to ask for approval.",
    },
    {
      value: "full-access",
      title: "Full access",
      detail: "Allow commands and edits without asking.",
    },
  ];
export default function Configure() {
  const { threadId, handoff } = useLocalSearchParams<{
    threadId?: string;
    handoff?: string;
  }>();
  const app = useApp();
  const { colors } = useTheme();
  const thread = app.threads.find((t) => t.id === threadId);
  const [options, setOptions] = useState<DraftOptions>(() =>
    thread
      ? {
          projectId: thread.project_id,
          provider: thread.provider.kind,
          instance: thread.provider.instance,
          model: thread.model ?? "",
          effort: thread.effort ?? "",
          permission: thread.permission_mode,
          worktree: !!thread.worktree,
          baseBranch: "",
        }
      : getDraft(),
  );
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [section, setSection] = useState("");
  const [modelQuery, setModelQuery] = useState("");
  const provider = app.providers.find((p) => p.kind === options.provider);
  const { models: visibleModels, customId } = modelChoices(
    provider?.models ?? [],
    options.model,
    modelQuery,
  );
  const project = app.projects.find((p) => p.id === options.projectId);
  const patch = (value: Partial<DraftOptions>) => {
    setOptions((p) => ({ ...p, ...value }));
  };
  useEffect(() => {
    let alive = true;
    if (options.projectId && !threadId)
      void rpc("git.branches", { project_id: options.projectId })
        .then((r) => {
          if (alive) setBranches(r.branches);
        })
        .catch(() => {
          if (alive) setBranches([]);
        });
    return () => {
      alive = false;
    };
  }, [options.projectId, threadId]);
  function chooseProvider(kind: ProviderKind) {
    const next = app.providers.find((p) => p.kind === kind);
    if (!next?.available) return;
    setModelQuery("");
    patch({
      provider: kind,
      instance: next.instances[0] ?? "default",
      model: "",
      effort: "",
      permission: next.supported_permission_modes.includes(options.permission)
        ? options.permission
        : (next.supported_permission_modes[0] ?? "supervised"),
    });
    void Haptics.selectionAsync();
  }
  async function save() {
    setBusy(true);
    setError("");
    try {
      if (threadId && handoff) {
        const source = await rpc("threads.get", { thread_id: threadId });
        const transcript = source.transcript
          .flatMap((e) =>
            e.role === "user"
              ? [
                  `User: ${e.message.parts.map((p) => (p.type === "text" ? p.text : p.type === "file_mention" ? `@${p.path}` : `[${p.type}]`)).join("\n")}`,
                ]
              : e.role === "assistant" && e.text
                ? [`Assistant: ${e.text}`]
                : [],
          )
          .join("\n\n");
        const created = await rpc("threads.create", {
          project_id: options.projectId,
          provider: { kind: options.provider, instance: options.instance },
          permission_mode: options.permission,
          model: options.model || undefined,
          effort: options.effort || undefined,
          message: {
            parts: [
              {
                type: "text",
                text: `Continue this coding session from the conversation below. Read the project before acting and preserve completed work.\n\n${transcript}`,
              },
            ],
          },
        });
        await refresh();
        router.dismiss();
        router.push({ pathname: "/thread/[id]", params: { id: created.id } });
      } else if (threadId) {
        await rpc("threads.update", {
          thread_id: threadId,
          ...(options.model !== (thread?.model ?? "")
            ? { model: options.model }
            : {}),
          ...(options.effort !== (thread?.effort ?? "")
            ? { effort: options.effort }
            : {}),
          ...(options.permission !== thread?.permission_mode
            ? { permission_mode: options.permission }
            : {}),
        });
        await Promise.all([refresh(), loadThread(threadId)]);
        router.back();
      } else {
        setDraft(options);
        router.back();
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const choose = (
    title: string,
    value: string,
    selected: boolean,
    onPress: () => void,
    detail?: string,
  ) => (
    <Tap
      key={value}
      label={title}
      selected={selected}
      onPress={onPress}
      style={[
        styles.spread,
        {
          padding: 14,
          borderRadius: 15,
          backgroundColor: selected ? colors.raised : undefined,
        },
      ]}
    >
      <View style={{ flex: 1, gap: 3 }}>
        <T variant="label">{title}</T>
        {detail && (
          <T variant="caption" tone="secondary">
            {detail}
          </T>
        )}
      </View>
      {selected && <Icon name="checkmark" size={16} color={colors.accent} />}
    </Tap>
  );
  return (
    <Page>
      {!threadId && (
        <Group title="Project">
          <Row
            title={project?.name ?? "Choose a project"}
            icon="folder"
            onPress={() => setSection(section === "project" ? "" : "project")}
          />
          {section === "project" &&
            app.projects.map((p) =>
              choose(
                p.name,
                p.id,
                p.id === options.projectId,
                () => {
                  patch({ projectId: p.id, baseBranch: "" });
                  setSection("");
                },
                p.path,
              ),
            )}
          {!app.projects.length && (
            <Button secondary onPress={() => router.push("/projects")}>
              Add a project
            </Button>
          )}
        </Group>
      )}
      <Group title={handoff ? "Hand off to" : "Agent"}>
        {app.providers.map((p) => (
          <Tap
            key={p.kind}
            label={`${p.display_name}${p.available ? "" : ", unavailable"}`}
            disabled={
              !p.available ||
              (!!threadId && !handoff && p.kind !== options.provider)
            }
            onPress={() => chooseProvider(p.kind)}
            style={[
              styles.spread,
              {
                padding: 14,
                borderRadius: 15,
                backgroundColor:
                  p.kind === options.provider ? colors.raised : undefined,
              },
            ]}
          >
            <View style={[styles.line, { flex: 1 }]}>
              <ProviderMark kind={p.kind} size={22} />
              <View style={{ flex: 1 }}>
                <T variant="label">{p.display_name}</T>
                {!p.available && (
                  <T variant="caption" tone="secondary">
                    Set up this agent on your computer.
                  </T>
                )}
              </View>
            </View>
            {p.kind === options.provider && <Icon name="checkmark" size={16} />}
          </Tap>
        ))}
      </Group>
      {(provider?.instances.length ?? 0) > 1 && (
        <Group title="Account">
          {provider!.instances.map((instance) =>
            choose(instance, instance, options.instance === instance, () =>
              patch({ instance }),
            ),
          )}
        </Group>
      )}
      <Group title="Model">
        <Row
          title={
            provider?.models?.find((m) => m.id === options.model)
              ?.display_name ??
            (options.model || "Agent default")
          }
          onPress={() => setSection(section === "model" ? "" : "model")}
        />
        {section === "model" && (
          <>
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
              <T variant="caption" tone="secondary">
                No models match your search.
              </T>
            )}
            {visibleModels.map((m) =>
              choose(m.display_name, m.id, options.model === m.id, () =>
                patch({
                  model: m.id,
                  ...(!m.custom &&
                  (!thread || handoff || provider?.supports_effort_switch)
                    ? { effort: m.default_effort ?? "" }
                    : {}),
                }),
              ),
            )}
            {customId &&
              choose(
                `Use “${customId}”`,
                "custom-model",
                false,
                () => {
                  patch({ model: customId });
                  setModelQuery("");
                },
                "Custom model ID",
              )}
          </>
        )}
      </Group>
      <Group title="Reasoning effort">
        {choose("Agent default", "default-effort", !options.effort, () =>
          patch({ effort: "" }),
        )}
        {(
          provider?.models?.find((m) => m.id === options.model)?.efforts ??
          provider?.supported_efforts ??
          []
        ).map((e) =>
          choose(
            e.charAt(0).toUpperCase() + e.slice(1),
            e,
            options.effort === e,
            () => patch({ effort: e }),
          ),
        )}
      </Group>
      <Group title="Permissions">
        {permissions
          .filter((p) => provider?.supported_permission_modes.includes(p.value))
          .map((p) =>
            choose(
              p.title,
              p.value,
              options.permission === p.value,
              () => patch({ permission: p.value }),
              p.detail,
            ),
          )}
      </Group>
      {!threadId && project?.is_git && (
        <Group title="Workspace">
          <Row
            title="Use a worktree"
            detail="Keep this thread’s changes in a separate checkout."
            trailing={
              <Toggle
                accessibilityLabel="Use a worktree"
                value={options.worktree}
                onValueChange={(worktree) => patch({ worktree })}
                trackColor={{ true: colors.accent }}
              />
            }
          />
          <Row
            title="Base branch"
            detail={options.baseBranch || "Current branch"}
            onPress={() => setSection(section === "branch" ? "" : "branch")}
          />
          {section === "branch" && (
            <>
              {choose("Current branch", "current", !options.baseBranch, () =>
                patch({ baseBranch: "" }),
              )}
              {branches.map((b) =>
                choose(b.name, b.name, b.name === options.baseBranch, () => {
                  patch({ baseBranch: b.name });
                  setSection("");
                }),
              )}
            </>
          )}
        </Group>
      )}
      <ErrorBanner error={error} />
      <Button
        onPress={() => void save()}
        busy={busy}
        disabled={!provider?.available || !project}
      >
        {handoff ? "Hand off conversation" : "Save setup"}
      </Button>
    </Page>
  );
}
