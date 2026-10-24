// Search for list screens. iOS: the native header search bar (collapses into
// the large title, system Cancel). Android and in-content uses: a 44 pt field.
import { Stack } from "expo-router";
import { useRef } from "react";
import { Platform, TextInput, View } from "react-native";
import { Icon, Tap } from "./primitives";
import { maxScale, radius, space, type as typography, useTheme } from "./theme";

/** An in-content search field: magnifier, text, clear button. */
export function SearchField({
  value,
  onChangeText,
  placeholder,
  onSubmit,
  autoFocus,
  fill,
}: {
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  onSubmit?: () => void;
  autoFocus?: boolean;
  /** Field fill; on a `grouped` page use `surface` so it reads as a field. */
  fill?: string;
}) {
  const { colors } = useTheme();
  const input = useRef<TextInput>(null);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        minHeight: 44,
        paddingStart: space.md,
        borderRadius: radius.sm,
        backgroundColor: fill ?? colors.raised,
      }}
    >
      <Icon name="magnifyingglass" size={17} color={colors.muted} />
      <TextInput
        ref={input}
        value={value}
        onChangeText={onChangeText}
        onSubmitEditing={onSubmit}
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        selectionColor={colors.accent}
        autoFocus={autoFocus}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        clearButtonMode="never"
        accessibilityLabel={placeholder}
        maxFontSizeMultiplier={maxScale("body")}
        underlineColorAndroid="transparent"
        style={[
          typography.body,
          { flex: 1, color: colors.ink, paddingVertical: 10, letterSpacing: 0 },
        ]}
      />
      {value ? (
        <Tap
          label="Clear search"
          feedback="none"
          onPress={() => {
            onChangeText("");
            input.current?.focus();
          }}
          style={{ alignItems: "center" }}
        >
          <Icon name="xmark.circle" size={17} color={colors.muted} />
        </Tap>
      ) : (
        <View style={{ width: space.md }} />
      )}
    </View>
  );
}

/**
 * A list screen's search. On iOS it configures the native header search bar
 * and renders nothing (the screen needs a native header and a scroll view with
 * `contentInsetAdjustmentBehavior="automatic"`). Elsewhere it renders a
 * SearchField where you place it, above the list.
 */
export function ListSearch(props: {
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  onSubmit?: () => void;
}) {
  const { colors } = useTheme();
  if (Platform.OS === "ios")
    return (
      <Stack.SearchBar
        placeholder={props.placeholder}
        onChangeText={(e) => props.onChangeText(e.nativeEvent.text)}
        onSearchButtonPress={() => props.onSubmit?.()}
        onCancelButtonPress={() => props.onChangeText("")}
        autoCapitalize="none"
        hideWhenScrolling
        tintColor={colors.accent}
      />
    );
  return <SearchField {...props} />;
}
