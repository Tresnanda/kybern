// "Set up project" (ADE-99 §2.3): a machine without a checkout gets the project. The source machine plans it, the sheet shows
// where it comes from and where it goes, and the progress follows `projects.provision.changed`. When it is done the target's
// lists are read again, so the row it came from becomes a choice.
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import Animated from "react-native-reanimated";
import {
  PROVISION_COPY,
  defaultEnvFiles,
  defaultPath,
  expandPath,
  partialGroupDetail,
  pathAccepted,
  provisionFraction,
  provisionSettled,
  provisionStatusText,
} from "../../../packages/kybern-client/src/provision";
import type { ProvisionPlan, ProvisionStatus } from "../../../packages/kybern-client/src/types";
import { errorText } from "../src/state/runtime";
import { followProvision, planProvision, refreshTarget, startProvision } from "../src/state/provisionFlow";
import { haptics } from "../src/ui/haptics";
import { InsetGroup, ListRow } from "../src/ui/List";
import { Busy } from "../src/ui/Busy";
import { Button, ErrorBanner, Field, T } from "../src/ui/primitives";
import { showToast } from "../src/ui/Toast";
import { radius, space, useTheme } from "../src/ui/theme";

export default function SetupProject() {
  const { source = "", projectId = "", target = "" } = useLocalSearchParams<{ source: string; projectId: string; target: string }>();
  const { colors } = useTheme();
  const route = { source, projectId, target };
  const [plan, setPlan] = useState<ProvisionPlan | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<ProvisionStatus | null>(null);
  const stop = useRef<(() => void) | null>(null);

  // The target proposes a folder; typing another one asks it again, so the answer says whether the folder can be used.
  useEffect(() => {
    let live = true;
    const typed = path === null || !plan ? undefined : expandPath(path, plan.target_home, plan.target.os);
    setChecking(!!plan);
    const timer = setTimeout(
      () => {
        planProvision(route, typed).then(
          (next) => {
            if (!live) return;
            setPlan(next);
            setError("");
            setChecking(false);
            if (path === null) setPath(defaultPath(next));
          },
          (e) => {
            if (!live) return;
            setError(errorText(e));
            setChecking(false);
          },
        );
      },
      plan ? 500 : 0,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [source, projectId, target, path]);
  useEffect(() => () => stop.current?.(), []);

  const running = !!status && !provisionSettled(status);
  const accepted = !!plan && !plan.blocked && !checking && pathAccepted(plan.path_check);
  const begin = async () => {
    if (!plan || !accepted) return;
    setError("");
    try {
      const first = await startProvision(route, {
        ...(path ? { path: expandPath(path, plan.target_home, plan.target.os) } : {}),
        env_files: defaultEnvFiles(plan.env_files),
      });
      setStatus(first);
      stop.current?.();
      stop.current = followProvision(route, first, (next) => {
        setStatus(next);
        if (next.phase === "done") {
          haptics.success();
          void refreshTarget(target);
        } else if (next.phase === "failed") haptics.error();
      });
    } catch (e) {
      setError(errorText(e));
    }
  };
  const done = status?.phase === "done";
  const failed = status?.phase === "failed" || status?.phase === "cancelled";
  const fraction = status ? provisionFraction(status) : null;
  const partial = plan ? partialGroupDetail(plan) : null;
  const remote = plan?.repos.find((repo) => repo.remote)?.remote;
  return (
    <>
      <Stack.Screen options={{ title: "Set up project", headerStyle: { backgroundColor: colors.grouped } }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        style={{ flex: 1, backgroundColor: colors.grouped }}
        contentContainerStyle={{ padding: space.lg, gap: space.lg }}
      >
        {!plan && !error ? <Busy /> : null}
        {plan ? (
          <>
            <T variant="subhead" tone="secondary">
              {partial ?? `${plan.target.name} has no checkout of ${plan.project_name}. ${PROVISION_COPY.sheetDescription(plan.target.name, plan.source.name)}`}
            </T>
            <InsetGroup>
              <ListRow title="Project" value={plan.project_name} />
              <ListRow title="From" value={remote ? "Remote repository" : plan.source.name} />
              <ListRow title="To" value={plan.target.name} />
              {plan.env_files.length ? <ListRow title={PROVISION_COPY.envFiles} value={`${defaultEnvFiles(plan.env_files).length} of ${plan.env_files.length}`} /> : null}
            </InsetGroup>
            <Field
              label={`Folder on ${plan.target.name}`}
              value={path ?? ""}
              onChangeText={setPath}
              editable={!running && !done}
              autoCapitalize="none"
              autoCorrect={false}
              error={plan.path_check && !pathAccepted(plan.path_check) ? plan.path_check.message : undefined}
            />
            {plan.env_files.length ? (
              <T variant="footnote" tone="muted">
                {PROVISION_COPY.envHint}
              </T>
            ) : null}
            {plan.blocked ? (
              <T variant="footnote" tone="negative">
                {plan.blocked}
              </T>
            ) : null}
          </>
        ) : null}
        {status ? (
          <View style={{ gap: space.sm }} accessibilityLiveRegion="polite">
            <View accessibilityRole="progressbar" style={{ height: 4, borderRadius: radius.full, backgroundColor: colors.line, overflow: "hidden" }}>
              <Animated.View
                style={{
                  height: 4,
                  width: `${Math.round((fraction ?? (running ? 0.15 : 0)) * 100)}%`,
                  backgroundColor: failed ? colors.negative : colors.accent,
                  transitionProperty: "width",
                  transitionDuration: 300,
                }}
              />
            </View>
            <T variant="footnote" tone={failed ? "negative" : "secondary"}>
              {provisionStatusText(status)}
            </T>
          </View>
        ) : null}
        <ErrorBanner error={error} />
        {plan ? (
          done ? (
            <Button
              role="prominent"
              onPress={() => {
                showToast(`${plan.project_name} is ready on ${plan.target.name}`);
                router.back();
              }}
            >
              {PROVISION_COPY.done}
            </Button>
          ) : (
            <Button role="prominent" busy={running} disabled={!accepted || running} onPress={() => void begin()}>
              {failed ? "Try again" : "Set up project"}
            </Button>
          )
        ) : null}
      </ScrollView>
    </>
  );
}
