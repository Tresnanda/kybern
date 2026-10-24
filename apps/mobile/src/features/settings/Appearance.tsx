import { InsetGroup, ListRow, SectionFooter, SectionHeader } from "../../ui/List";
import { useTheme, type Appearance } from "../../ui/theme";

export const APPEARANCE_LABELS: Record<Appearance, string> = {
  system: "Match device",
  light: "Light",
  dark: "Dark",
};

export function AppearanceSettings() {
  const { appearance, setAppearance } = useTheme();
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
    </>
  );
}
