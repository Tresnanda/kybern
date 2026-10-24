// Development-only sheet demo for the design kit (app/dev-kit.tsx).
import { Redirect, router } from "expo-router";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { InsetGroup, ListRow, SectionHeader } from "../src/ui/List";
import { Button } from "../src/ui/primitives";
import { space, useTheme } from "../src/ui/theme";

export default function DevSheet() {
  const { colors } = useTheme();
  const [agent, setAgent] = useState("claude");
  if (!__DEV__) return <Redirect href="/" />;
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ flex: 1, backgroundColor: colors.grouped }}
      contentContainerStyle={{ padding: space.lg, gap: space.sm }}
    >
      <SectionHeader title="Agent" first />
      <InsetGroup>
        {[
          ["claude", "Claude Code"],
          ["codex", "Codex"],
          ["opencode", "OpenCode"],
        ].map(([id, title]) => (
          <ListRow key={id} title={title!} checked={agent === id} onPress={() => setAgent(id!)} />
        ))}
      </InsetGroup>
      <View style={{ marginTop: space.xl }}>
        <Button role="prominent" onPress={() => router.back()}>
          Done
        </Button>
      </View>
    </ScrollView>
  );
}
