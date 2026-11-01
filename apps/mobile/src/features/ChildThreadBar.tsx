// The bar a child thread shows above its composer (parity P1-4): a provider subagent
// or a delegated agent says what state it is in, for how long, and can be stopped.
// The way back to the conversation that started it is the header breadcrumb.
import { useEffect, useState } from "react";
import { View } from "react-native";
import {
  canStopDelegation,
  childEndedAt,
  childStartedAt,
  childState,
  delegationRoleLabel,
  isChildWorking,
  workspaceLabel,
} from "../../../../packages/kybern-client/src/delegations";
import {
  isRemoteChildThread,
  formatElapsed,
  subagentBarState,
  subagentDetail,
  subagentTypeLabel,
} from "../../../../packages/kybern-client/src/subagents";
import type { Thread } from "../state/protocol";
import { errorText, machineHub, rpc, useApp, useMachineView } from "../state/runtime";
import { showToast } from "../ui/Toast";
import { Button, T } from "../ui/primitives";
import { StatusGlyph } from "../ui/TaskGlyphs";
import { space } from "../ui/theme";

function useTick(live: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  return now;
}

export function ChildThreadBar({ thread }: { thread?: Thread | null }) {
  const app = useApp();
  const view = useMachineView();
  const working = !!thread && isChildWorking(thread);
  const now = useTick(working);
  const [stopping, setStopping] = useState(false);
  if (!thread || (!thread.subagent && !thread.delegation)) return null;
  const started = childStartedAt(thread);
  const ended = childEndedAt(thread);
  const elapsed = started ? (ended ?? now) - started : null;
  let label: string;
  let detail: string | null;
  const state = childState(thread);
  if (thread.subagent) {
    label = subagentBarState(thread, elapsed).label;
    detail = [subagentTypeLabel(thread.subagent.agent_type), subagentDetail(thread)?.text].filter(Boolean).join(" · ") || null;
  } else {
    label = elapsed != null && elapsed > 0 ? `${state.word} · ${formatElapsed(elapsed)}` : state.word;
    detail = [delegationRoleLabel(thread.delegation!.role), workspaceLabel(thread.delegation!)].join(" · ");
  }
  // A child another machine started runs on its own machine: say which.
  if (view.machines.length > 1 && isRemoteChildThread(thread)) {
    const owner = machineHub().machineOfThread(thread.id);
    const name = view.machines.find((machine) => machine.machineId === owner)?.name;
    if (name) detail = [detail, `Runs on ${name}`].filter(Boolean).join(" · ");
  }
  const stoppable = thread.subagent ? working : canStopDelegation(thread);
  async function stop() {
    setStopping(true);
    try {
      await rpc("threads.interrupt", { thread_id: thread!.id });
      showToast(`Stopped ${thread!.title || "the agent"}`);
    } catch (e) {
      showToast(`Couldn't stop ${thread!.title || "the agent"}. ${errorText(e)}`);
    } finally {
      setStopping(false);
    }
  }
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 36 }}>
      <StatusGlyph phase={thread.subagent?.status === "pending" ? "queued" : state.phase} size={16} animated={working} />
      <View style={{ flex: 1 }}>
        <T variant="footnote" style={{ fontWeight: "500", fontVariant: ["tabular-nums"] }} numberOfLines={1}>
          {label}
        </T>
        {detail ? (
          <T variant="caption" tone="secondary" numberOfLines={1}>
            {detail}
          </T>
        ) : null}
      </View>
      {stoppable && (
        <Button
          role="destructive"
          size="medium"
          busy={stopping}
          disabled={app.status !== "open"}
          label={`Stop ${thread.title || "agent"}`}
          onPress={() => void stop()}
        >
          Stop
        </Button>
      )}
    </View>
  );
}
