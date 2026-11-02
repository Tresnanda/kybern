// Rename a machine for the whole network (`network.rename`, asked of a member). A short sheet: one field.
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Platform, ScrollView } from "react-native";
import { MACHINES_COPY } from "../src/machines/settingsModel";
import { renameMachine } from "../src/state/machineActions";
import { HeaderActions } from "../src/ui/ActionMenu";
import { haptics } from "../src/ui/haptics";
import { Button, ErrorBanner, Field } from "../src/ui/primitives";
import { space, useTheme } from "../src/ui/theme";

export default function MachineRename() {
  const { id = "", name: current = "" } = useLocalSearchParams<{ id: string; name?: string }>();
  const { colors } = useTheme();
  const [name, setName] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const trimmed = name.trim();
  const ready = !!trimmed && trimmed !== current.trim() && !busy;
  const save = async () => {
    if (!ready) return;
    setBusy(true);
    setError("");
    try {
      await renameMachine(id, trimmed);
      haptics.success();
      router.back();
    } catch {
      setError(MACHINES_COPY.renameError);
      setBusy(false);
    }
  };
  return (
    <>
      <Stack.Screen options={{ title: MACHINES_COPY.renameTitle, headerStyle: { backgroundColor: colors.grouped } }} />
      {Platform.OS === "ios" && <HeaderActions buttons={[{ title: MACHINES_COPY.renameAction, prominent: true, disabled: !ready, onPress: () => void save() }]} />}
      <ScrollView style={{ flex: 1, backgroundColor: colors.grouped }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
        <Field
          label={MACHINES_COPY.renameField}
          placeholder={MACHINES_COPY.renamePlaceholder}
          value={name}
          onChangeText={setName}
          autoFocus
          autoCorrect={false}
          maxLength={64}
          returnKeyType="done"
          onSubmitEditing={() => void save()}
        />
        <ErrorBanner error={error} />
        {Platform.OS !== "ios" && (
          <Button role="prominent" busy={busy} disabled={!ready} onPress={() => void save()}>
            {MACHINES_COPY.renameAction}
          </Button>
        )}
      </ScrollView>
    </>
  );
}
