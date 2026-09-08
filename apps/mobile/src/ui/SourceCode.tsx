import { useMemo } from "react";
import { ScrollView, Text } from "react-native";
import { codeTokens } from "./codeTokens";
import { useTheme } from "./theme";
export function SourceCode({
  text,
  language,
}: {
  text: string;
  language: string;
}) {
  const { colors, dark } = useTheme();
  const tokens = useMemo(() => codeTokens(text, language), [text, language]);
  const palette = {
    plain: colors.ink,
    comment: colors.secondary,
    string: dark ? "#A6D7A5" : "#286A38",
    keyword: dark ? "#C7B4FA" : "#6E3A9F",
    number: dark ? "#EBC08C" : "#945018",
  };
  return (
    <ScrollView horizontal contentContainerStyle={{ padding: 20 }}>
      <Text
        selectable
        style={{
          fontFamily: "Menlo",
          fontSize: 13,
          lineHeight: 21,
          color: colors.ink,
        }}
      >
        {tokens.map((token, i) => (
          <Text key={i} style={{ color: palette[token.kind] }}>
            {token.text}
          </Text>
        ))}
      </Text>
    </ScrollView>
  );
}
