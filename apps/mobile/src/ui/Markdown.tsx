import * as Clipboard from "expo-clipboard";
import { memo, useMemo } from "react";
import { Image, Linking, ScrollView, Text, View } from "react-native";
import { IconButton, T, styles } from "./primitives";
import { useTheme } from "./theme";

export function openLink(url: string) {
  if (/^(https?:|mailto:)/i.test(url))
    void Linking.openURL(url).catch(() => {});
}
function Inline({ text }: { text: string }) {
  const { colors } = useTheme();
  return (
    <>
      {text
        .split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*]+\*)/g)
        .map((part, i) => {
          if (part.startsWith("**") && part.endsWith("**"))
            return (
              <Text key={i} style={{ fontWeight: "600" }}>
                {<Inline text={part.slice(2, -2)} />}
              </Text>
            );
          if (part.startsWith("`") && part.endsWith("`"))
            return (
              <Text
                key={i}
                style={{
                  fontFamily: "Menlo",
                  fontSize: 14,
                  backgroundColor: colors.raised,
                }}
              >
                {part.slice(1, -1)}
              </Text>
            );
          const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
          if (link)
            return (
              <Text
                key={i}
                accessibilityRole="link"
                onPress={() => openLink(link[2]!)}
                style={{
                  textDecorationLine: "underline",
                  color: colors.accent,
                }}
              >
                {link[1]}
              </Text>
            );
          if (part.startsWith("*") && part.endsWith("*"))
            return (
              <Text key={i} style={{ fontStyle: "italic" }}>
                {part.slice(1, -1)}
              </Text>
            );
          return part;
        })}
    </>
  );
}
export const Code = memo(function Code({
  text,
  language = "",
  diff = false,
}: {
  text: string;
  language?: string;
  diff?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        backgroundColor: colors.code,
        borderRadius: 16,
        overflow: "hidden",
        marginVertical: 8,
      }}
    >
      <View style={[styles.spread, { paddingStart: 15, paddingEnd: 4 }]}>
        <T variant="caption" tone="secondary">
          {language || (diff ? "Changes" : "Code")}
        </T>
        <IconButton
          name="doc.on.doc"
          label="Copy code"
          onPress={() => void Clipboard.setStringAsync(text)}
        />
      </View>
      <ScrollView
        horizontal
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 18 }}
      >
        <Text
          selectable
          style={{
            fontFamily: "Menlo",
            fontSize: 13,
            lineHeight: 21,
            color: colors.ink,
          }}
        >
          {diff
            ? text.split("\n").map((line, i) => (
                <Text
                  key={i}
                  style={{
                    color: line.startsWith("+")
                      ? colors.positive
                      : line.startsWith("-")
                        ? colors.negative
                        : line.startsWith("@@")
                          ? colors.accent
                          : colors.ink,
                  }}
                >
                  {line}
                  {"\n"}
                </Text>
              ))
            : text}
        </Text>
      </ScrollView>
    </View>
  );
});
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const sections = useMemo(() => text.split(/(```[\s\S]*?(?:```|$))/g), [text]);
  return (
    <View style={{ gap: 10 }}>
      {sections.filter(Boolean).map((section, s) => {
        if (section.startsWith("```")) {
          const first = section.indexOf("\n");
          return (
            <Code
              key={`code:${s}`}
              language={section.slice(3, first < 0 ? undefined : first).trim()}
              text={
                first < 0
                  ? ""
                  : section
                      .slice(first + 1)
                      .replace(/```$/, "")
                      .trimEnd()
              }
            />
          );
        }
        return section
          .replace(/^(#{1,6} .+)$/gm, "\n\n$1\n\n")
          .trim()
          .split(/\n\s*\n/)
          .filter(Boolean)
          .map((para, p) => (
            <MarkdownParagraph key={`${s}-${p}`} para={para} />
          ));
      })}
    </View>
  );
});
// Completed paragraphs retain native text, selection and table scroll state while
// the current paragraph grows. Only its changed string crosses this memo boundary.
const MarkdownParagraph = memo(function MarkdownParagraph({
  para,
}: {
  para: string;
}) {
  const { colors } = useTheme();
  const picture = /^!\[([^\]]*)\]\((https?:\/\/[^)]+)\)$/.exec(para);
  if (picture)
    return (
      <View style={{ gap: 6 }}>
        <Image
          source={{ uri: picture[2] }}
          accessibilityLabel={picture[1] || "Image from response"}
          style={{ width: "100%", height: 240, borderRadius: 14 }}
          resizeMode="contain"
        />
        {!!picture[1] && (
          <T variant="caption" tone="secondary">
            {picture[1]}
          </T>
        )}
      </View>
    );
  const lines = para.split("\n");
  if (
    lines.length > 1 &&
    /^\s*\|?\s*:?-{3,}/.test(lines[1]!) &&
    lines[0]!.includes("|")
  ) {
    const cells = (line: string) =>
      line
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => cell.trim());
    const rows = [cells(lines[0]!), ...lines.slice(2).map(cells)];
    return (
      <ScrollView horizontal style={{ marginVertical: 8 }}>
        <View
          style={{
            borderWidth: 1,
            borderColor: colors.line,
            borderRadius: 12,
            overflow: "hidden",
          }}
        >
          {rows.map((row, r) => (
            <View
              key={r}
              style={{
                flexDirection: "row",
                backgroundColor: r === 0 ? colors.raised : undefined,
                borderBottomWidth: r < rows.length - 1 ? 1 : 0,
                borderBottomColor: colors.line,
              }}
            >
              {row.map((cell, c) => (
                <View key={c} style={{ width: 180, padding: 12 }}>
                  <T selectable variant={r === 0 ? "label" : "caption"}>
                    <Inline text={cell} />
                  </T>
                </View>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    );
  }
  if (/^#{1,6}\s/.test(para))
    return (
      <T
        variant={para.startsWith("# ") ? "title" : "heading"}
        style={{ marginTop: 12 }}
      >
        <Inline text={para.replace(/^#{1,6}\s/, "")} />
      </T>
    );
  if (/^[-*_]{3,}$/.test(para))
    return (
      <View
        style={{
          height: 1,
          backgroundColor: colors.line,
          marginVertical: 8,
        }}
      />
    );
  if (/^>/.test(para))
    return (
      <View
        style={{
          borderStartWidth: 2,
          borderColor: colors.line,
          paddingStart: 16,
        }}
      >
        <T tone="secondary" selectable>
          <Inline text={para.replace(/^> ?/gm, "")} />
        </T>
      </View>
    );
  if (/^(?:[-*+] |\d+\. )/m.test(para))
    return (
      <View style={{ gap: 8 }}>
        {para.split("\n").map((line, i) => {
          const match = /^(\s*)([-*+]|\d+\.)\s(.*)$/.exec(line);
          return (
            <View
              key={i}
              style={{
                flexDirection: "row",
                paddingStart: match ? Math.min(match[1]!.length * 4, 32) : 0,
                gap: 10,
              }}
            >
              {match && (
                <T tone="secondary" style={{ minWidth: 15 }}>
                  {/\d/.test(match[2]!) ? match[2] : "•"}
                </T>
              )}
              <T selectable style={{ flex: 1 }}>
                <Inline text={match?.[3] ?? line} />
              </T>
            </View>
          );
        })}
      </View>
    );
  return (
    <T selectable>
      <Inline text={para} />
    </T>
  );
});
