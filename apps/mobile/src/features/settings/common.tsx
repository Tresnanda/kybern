// Building blocks every Settings page shares: a titled InsetGroup with its
// footer, a toggle row, and the "connect first" state. Pages render only their
// groups; the host (phone route or iPad detail) owns the scroll view.
import { router } from "expo-router";
import { Children, type PropsWithChildren, type ReactNode } from "react";
import { View } from "react-native";
import { useApp } from "../../state/runtime";
import { useSettings } from "../../state/settings";
import { InsetGroup, ListRow, SectionFooter, SectionHeader } from "../../ui/List";
import { ErrorBanner } from "../../ui/primitives";
import { Toggle } from "../../ui/Toggle";
import { useTheme } from "../../ui/theme";

/** A titled group of rows. `first` drops the top padding of the page's first group. */
export function Section({
  title,
  footer,
  first,
  action,
  children,
}: PropsWithChildren<{
  title?: string;
  footer?: string | null;
  first?: boolean;
  action?: { title: string; onPress: () => void; label?: string };
}>) {
  const rows = Children.toArray(children).filter(Boolean);
  return (
    <View style={!title && !first ? { marginTop: 32 } : undefined}>
      {title ? <SectionHeader title={title} inset first={first} action={action} /> : null}
      {rows.length ? <InsetGroup>{rows}</InsetGroup> : null}
      {footer ? <SectionFooter inset>{footer}</SectionFooter> : null}
    </View>
  );
}

/** A setting that is on or off. */
export function ToggleRow({
  title,
  subtitle,
  value,
  onChange,
  disabled,
  leading,
}: {
  title: string;
  subtitle?: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  leading?: ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <ListRow
      title={title}
      subtitle={subtitle}
      leading={leading}
      label={`${title}, ${value ? "on" : "off"}`}
      trailing={
        <Toggle
          accessibilityLabel={title}
          value={value}
          disabled={disabled}
          onValueChange={onChange}
          trackColor={{ true: colors.accent }}
        />
      }
    />
  );
}

/**
 * Renders `children` once the computer's settings are here. While disconnected
 * it offers the way back instead; a failed save or read shows above.
 */
export function WithSettings({ children }: { children: ReactNode }) {
  const app = useApp();
  const { settings, error } = useSettings();
  // A reconnect in progress keeps the page quiet; only a lost connection offers the way back.
  if (app.status === "connecting" || app.status === "reconnecting") return null;
  if (app.status !== "open")
    return (
      <Section first footer="Reconnect to change these settings.">
        <ListRow
          title="Connect your computer"
          leading="laptopcomputer"
          chevron
          onPress={() => router.push("/connect")}
        />
      </Section>
    );
  return (
    <>
      <ErrorBanner error={error} />
      {settings ? children : null}
    </>
  );
}
