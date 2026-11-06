// A failed turn the daemon could name (signed out, a usage limit, no connection, ...), in the words `describeTurnFailure` writes for a phone:
// what happened, and what to do on the computer that ran it. A phone runs no fix, so there are no buttons. This is the one place the
// transcript shows a named failure; the shared Problem component can replace the body of `TurnProblemLine` without touching the transcript.
import { View } from "react-native";
import { describeTurnFailure } from "../../../../packages/kybern-client/src/problems";
import type { Problem } from "../../../../packages/kybern-client/src/types";
import { activeEnvironment, useThreadValue } from "../state/runtime";
import type { ThreadState } from "../state/transcript";
import { T } from "../ui/primitives";
import { space } from "../ui/theme";

const providerOf = (snapshot: ThreadState) => snapshot.thread?.provider;

/** The failed turn as a headline and one sentence, or the agent's own text when Kybern could not name the cause. */
export function TurnProblemLine({ threadId, error, problem }: { threadId: string; error: string; problem?: Problem }) {
  const provider = useThreadValue(threadId, providerOf);
  const view =
    problem && provider ? describeTurnFailure({ error, problem }, { provider: provider.kind, instance: provider.instance, machine: activeEnvironment()?.name, phone: true }) : null;
  if (!view)
    return (
      <T variant="footnote" tone="negative">
        {error}
      </T>
    );
  return (
    <View accessibilityRole="alert" style={{ gap: space.xs }}>
      <T variant="subhead" tone="negative">
        {view.title}
      </T>
      <T variant="footnote" tone="muted">
        {view.body}
      </T>
    </View>
  );
}
