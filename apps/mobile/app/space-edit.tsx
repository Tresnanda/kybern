import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Platform, ScrollView, View } from "react-native";
import { SPACE_COLORS, SPACE_NAME_MAX } from "../../../packages/kybern-client/src/spaces";
import type { SpaceColor } from "../src/state/protocol";
import { errorText } from "../src/state/runtime";
import {
  createSpace,
  nextSpaceColor,
  setCurrentSpace,
  SPACE_COPY,
  updateSpace,
  useSpaces,
} from "../src/state/spaces";
import { HeaderActions } from "../src/ui/ActionMenu";
import { haptics } from "../src/ui/haptics";
import { SectionHeader } from "../src/ui/List";
import { Button, ErrorBanner, Field, Icon, T, Tap } from "../src/ui/primitives";
import { SpaceTile, SPACE_SWATCHES } from "../src/ui/SpaceTile";
import { radius, space as spacing, useTheme } from "../src/ui/theme";

const COLOR_NAME: Record<SpaceColor, string> = {
  blue: "Blue",
  green: "Green",
  purple: "Purple",
  pink: "Pink",
  teal: "Teal",
  amber: "Amber",
  red: "Red",
  graphite: "Graphite",
};

// New space / Edit space: a name and a colour. The tile previews both.
export default function SpaceEdit() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const s = useSpaces();
  const { colors } = useTheme();
  const existing = s.spaces.find((space) => space.id === id);
  const [name, setName] = useState(existing?.name ?? "");
  const [color, setColor] = useState<SpaceColor>(existing?.color ?? nextSpaceColor(s.spaces));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const trimmed = name.trim();
  const clash = s.spaces.some((space) => space.id !== id && space.name.toLowerCase() === trimmed.toLowerCase());
  const ready = trimmed.length > 0 && trimmed.length <= SPACE_NAME_MAX && !clash && !busy;
  const title = existing ? SPACE_COPY.editorEditTitle : SPACE_COPY.editorNewTitle;
  const commit = existing ? SPACE_COPY.save : SPACE_COPY.create;

  const save = async () => {
    if (!ready) return;
    setBusy(true);
    setError("");
    try {
      if (existing) await updateSpace(existing.id, { name: trimmed, color });
      else setCurrentSpace((await createSpace(trimmed, color)).id);
      haptics.success();
      router.back();
    } catch (e) {
      setError(errorText(e) || SPACE_COPY.saveFailure);
      setBusy(false);
    }
  };

  return (
    <>
      <Stack.Screen options={{ title, headerStyle: { backgroundColor: colors.grouped } }} />
      {Platform.OS === "ios" && (
        <HeaderActions buttons={[{ title: commit, prominent: true, disabled: !ready, onPress: () => void save() }]} />
      )}
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.grouped }}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}
    >
        <View style={{ alignItems: "center", paddingVertical: spacing.sm }}>
          <SpaceTile space={{ name: trimmed || "?", color }} size={56} />
        </View>
        <Field
          label={SPACE_COPY.nameLabel}
          placeholder={SPACE_COPY.namePlaceholder}
          value={name}
          onChangeText={setName}
          maxLength={SPACE_NAME_MAX}
          returnKeyType="done"
          onSubmitEditing={() => void save()}
          error={clash ? `You already have a space named “${trimmed}”.` : undefined}
        />
        <View>
          <SectionHeader title="Colour" first />
          <View accessibilityRole="radiogroup" style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.md }}>
            {SPACE_COLORS.map((value) => {
              const selected = value === color;
              return (
                <Tap
                  key={value}
                  label={COLOR_NAME[value]}
                  selected={selected}
                  feedback="scale"
                  onPress={() => {
                    haptics.select();
                    setColor(value);
                  }}
                  style={{ alignItems: "center" }}
                >
                  <View
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: radius.full,
                      backgroundColor: SPACE_SWATCHES[value].fill,
                      alignItems: "center",
                      justifyContent: "center",
                      borderWidth: 2,
                      borderColor: selected ? colors.ink : "transparent",
                    }}
                  >
                    {selected ? <Icon name="checkmark" size={16} color={SPACE_SWATCHES[value].fg} /> : null}
                  </View>
                </Tap>
              );
            })}
          </View>
        </View>
        <ErrorBanner error={error} />
        {existing?.is_default ? (
          <T variant="footnote" tone="muted">
            {`${SPACE_COPY.defaultBadge}. ${SPACE_COPY.defaultCantDelete}`}
          </T>
        ) : null}
        {Platform.OS !== "ios" && (
          <Button role="prominent" busy={busy} disabled={!ready} onPress={() => void save()}>
            {commit}
          </Button>
        )}
    </ScrollView>
    </>
  );
}
