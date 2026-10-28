import { Text, View } from "react-native";
import { InsetGroup, ListRow, SectionFooter, SectionHeader } from "../../ui/List";
import { T } from "../../ui/primitives";
import { StepSlider } from "../../ui/StepSlider";
import { TEXT_SCALES, textScaleLabel } from "../../ui/textScale";
import { space, useTextScale, useTheme, type Appearance } from "../../ui/theme";

export const APPEARANCE_LABELS: Record<Appearance, string> = {
  system: "Match device",
  light: "Light",
  dark: "Dark",
};

export function AppearanceSettings() {
  const { appearance, setAppearance, colors } = useTheme();
  const { textScale, setTextScale } = useTextScale();
  // The end marks stay one size, so the control itself never moves under the finger.
  const mark = (fontSize: number) => (
    <Text allowFontScaling={false} style={{ fontSize, fontWeight: "500", color: colors.secondary, width: 22, textAlign: "center" }}>
      A
    </Text>
  );
  return (
    <>
      <SectionHeader title="Appearance" inset first />
      <InsetGroup>
        {(["system", "light", "dark"] as const).map((value) => (
          <ListRow
            key={value}
            title={APPEARANCE_LABELS[value]}
            checked={value === appearance}
            onPress={() => setAppearance(value)}
          />
        ))}
      </InsetGroup>
      {appearance === "system" ? (
        <SectionFooter inset>Follows your device's light or dark setting.</SectionFooter>
      ) : null}
      <SectionHeader title="Text size" inset />
      <InsetGroup>
        <View style={{ padding: space.lg, gap: space.md }}>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.md }}>
            <T variant="prose" style={{ flex: 1 }}>
              The quick reply looks like this.
            </T>
            <T variant="footnote" tone="secondary" style={{ fontVariant: ["tabular-nums"] }}>
              {textScaleLabel(textScale)}
            </T>
          </View>
          <StepSlider
            label="Text size"
            steps={TEXT_SCALES.length}
            index={TEXT_SCALES.indexOf(textScale)}
            valueText={textScaleLabel(textScale)}
            onChange={(index) => setTextScale(TEXT_SCALES[index]!)}
            leading={mark(13)}
            trailing={mark(21)}
          />
        </View>
      </InsetGroup>
      <SectionFooter inset>
        Applies to conversations, lists and menus on this phone, on top of your device's text size.
      </SectionFooter>
    </>
  );
}
