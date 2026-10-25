// A Coordinator's handoff, read-only: opened from the "Context refreshed" row in the conversation.
import { Stack, useLocalSearchParams } from "expo-router";
import { ScrollView, View } from "react-native";
import {
  ROTATION_COPY,
  parseHandoff,
  missingHandoffText,
  rotationMeta,
} from "../../../packages/kybern-client/src/rotation";
import { useThread } from "../src/state/runtime";
import { Markdown } from "../src/ui/Markdown";
import { Empty, T } from "../src/ui/primitives";
import { space, useTheme } from "../src/ui/theme";

export default function HandoffSheet() {
  const { threadId = "", rotationId = "" } = useLocalSearchParams<{ threadId: string; rotationId: string }>();
  const { colors } = useTheme();
  const { blocks } = useThread(threadId);
  const block = blocks.find((candidate) => candidate.kind === "rotation" && candidate.rotationId === rotationId);
  const rotation = block?.kind === "rotation" ? block : null;
  const missing = rotation?.handoffStatus?.status === "missing";
  const sections = rotation && !missing ? parseHandoff(rotation.handoff) : [];
  return (
    <>
      <Stack.Screen options={{ headerStyle: { backgroundColor: colors.grouped } }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={{ flex: 1, backgroundColor: colors.grouped }}
        contentContainerStyle={{ padding: space.lg, paddingBottom: space["3xl"], gap: space.lg }}
      >
        {!rotation ? (
          <Empty title="Handoff not found" detail="It may be on an older page of this conversation." />
        ) : (
          <>
            <View style={{ gap: space.xs }}>
              <T variant="footnote" tone="secondary">
                {rotationMeta(rotation)}
              </T>
              {rotation.edited && (
                <T variant="footnote" tone="muted">
                  {ROTATION_COPY.edited}
                </T>
              )}
            </View>
            {missing ? (
              <T variant="subhead" tone="secondary" selectable>
                {missingHandoffText(rotation.handoffStatus)}
              </T>
            ) : (
              sections.map((section, index) => (
                <View key={`${index}:${section.heading}`} style={{ gap: space.xs }}>
                  {!!section.label && (
                    <T variant="footnote" tone="secondary" style={{ fontWeight: "500" }}>
                      {section.label}
                    </T>
                  )}
                  <Markdown text={section.none ? "None" : section.body} />
                </View>
              ))
            )}
          </>
        )}
      </ScrollView>
    </>
  );
}
