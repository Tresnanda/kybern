import * as Clipboard from "expo-clipboard";
import { createContext, memo, useContext, useMemo, type ReactNode } from "react";
import { router } from "expo-router";
import { chatLink, kybernRef, splitKybernRefs, type KybernRef } from "../../../../packages/kybern-client/src/chatLinks";
import { ChatFileContext } from "../state/chatFileContext";
import { Alert } from "./Alert";
import { Image, Linking, ScrollView, Text, View } from "react-native";
import { Icon, IconButton, T, styles } from "./primitives";
import { useTheme } from "./theme";
import { taskLinkId } from "../state/tasksModel";
import { TaskRef } from "./TaskRef";
import { NoteRef } from "./NoteRef";

export function openLink(url: string) {
  if (/^(https?:|mailto:)/i.test(url))
    void Linking.openURL(url).catch(() => {});
}
/** In a chat message a task reference also reads its title and notices when it is deleted. */
const ChatRefs = createContext(false);

function RefChip({ reference, label, checklist }: { reference: KybernRef; label: string; checklist?: boolean }) {
  const chat = useContext(ChatRefs);
  return reference.target === "task" ? (
    <TaskRef id={reference.id} label={label} checklist={checklist} chat={chat} />
  ) : (
    <NoteRef id={reference.id} label={label} />
  );
}
/** Plain text, with any bare `kybern://note|task/<id>` in it drawn as a reference. */
function RefText({ text, checklist }: { text: string; checklist?: boolean }) {
  if (!text.includes("kybern://")) return <>{text}</>;
  return (
    <>
      {splitKybernRefs(text).map((part, i): ReactNode =>
        "ref" in part ? (
          <RefChip key={i} reference={part.ref} label={part.text} checklist={checklist} />
        ) : (
          part.text
        ),
      )}
    </>
  );
}
function Inline({ text, checklist }: { text: string; checklist?: boolean }) {
  const { colors } = useTheme();
  const fileContext = useContext(ChatFileContext);
  return (
    <>
      {text
        .split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*]+\*)/g)
        .map((part, i) => {
          if (part.startsWith("**") && part.endsWith("**"))
            return (
              <Text key={i} style={{ fontWeight: "600" }}>
                {<Inline text={part.slice(2, -2)} checklist={checklist} />}
              </Text>
            );
          const codeRef =
            part.startsWith("`") && part.endsWith("`")
              ? kybernRef(part.slice(1, -1))
              : null;
          if (codeRef)
            return (
              <RefChip
                key={i}
                reference={codeRef}
                label=""
                checklist={checklist}
              />
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
          const linked = link ? kybernRef(link[2]!) : null;
          const taskId = link ? taskLinkId(link[2]!) : null;
          if (link && (linked || taskId))
            return (
              <RefChip
                key={i}
                reference={linked ?? { target: "task", id: taskId! }}
                label={link[1]!}
                checklist={checklist}
              />
            );
          if (link)
            return (
              <Text
                key={i}
                accessibilityRole="link"
                onPress={() => {
                  const target = chatLink(link[2]!, fileContext?.basePath);
                  if (target.kind === "external") openLink(target.url);
                  else if (target.kind === "file" && fileContext) router.push({
                    pathname: "/file",
                    params: { threadId: fileContext.threadId, projectId: fileContext.projectId, path: target.path, scope: fileContext.scope ?? "thread", ...(target.line ? { line: String(target.line) } : {}) },
                  });
                  else if (target.kind !== "anchor") Alert.alert("Unable to open link", target.kind === "file" ? "Open this file from its conversation." : "This link cannot be opened.");
                }}
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
          return <RefText key={i} text={part} checklist={checklist} />;
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
export const Markdown = memo(function Markdown({
  text,
  chat = false,
}: {
  text: string;
  /** A message in a conversation: references read their title and notice deletions. */
  chat?: boolean;
}) {
  const sections = useMemo(() => text.split(/(```[\s\S]*?(?:```|$))/g), [text]);
  return (
    <ChatRefs value={chat}>
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
    </ChatRefs>
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
          // Checklist items (`- [ ] item`) show a checkbox instead of a bullet.
          const task = match ? /^\[( |x|X)\]\s+(.*)$/.exec(match[3]!) : null;
          const checked = task ? task[1] !== " " : false;
          return (
            <View
              key={i}
              style={{
                flexDirection: "row",
                paddingStart: match ? Math.min(match[1]!.length * 4, 32) : 0,
                gap: 10,
              }}
            >
              {task ? (
                <View
                  accessible
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked }}
                  style={{ minWidth: 15, paddingTop: 3 }}
                >
                  <Icon
                    name={checked ? "checkmark.square.fill" : "square"}
                    size={19}
                    color={checked ? colors.accent : colors.secondary}
                  />
                </View>
              ) : (
                match && (
                  <T tone="secondary" style={{ minWidth: 15 }}>
                    {/\d/.test(match[2]!) ? match[2] : "•"}
                  </T>
                )
              )}
              <T
                selectable
                tone={checked ? "secondary" : "ink"}
                style={{
                  flex: 1,
                  textDecorationLine: checked ? "line-through" : "none",
                }}
              >
                <Inline text={task ? task[2]! : (match?.[3] ?? line)} checklist={!!task} />
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
