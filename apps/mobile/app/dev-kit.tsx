// Development-only gallery of the design system (docs/design-system.md).
// Open it with `exp://<host>:<port>/--/dev-kit` (Expo Go) or `kybern://dev-kit`.
// Release builds redirect home.
import { Redirect, router, Stack } from "expo-router";
import { useState, type PropsWithChildren } from "react";
import { ScrollView, View, useWindowDimensions } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import { count, plural } from "../src/state/format";
import { runtimeStatus, taskStatus, type StatusPhase } from "../src/state/status";
import { ContextMenu, HeaderActions, MenuButton, type MenuItem } from "../src/ui/ActionMenu";
import { confirm } from "../src/ui/Alert";
import { ChromeBar, ChromeProvider, useChromeInsets } from "../src/ui/ChromeBar";
import {
  DisclosureRow,
  InsetGroup,
  ListRow,
  ListSeparator,
  SectionFooter,
  SectionHeader,
} from "../src/ui/List";
import {
  Button,
  Empty,
  ErrorBanner,
  Field,
  Icon,
  IconButton,
  T,
  Tap,
  type ButtonRole,
} from "../src/ui/primitives";
import { ProviderMark } from "../src/ui/ProviderMark";
import { ListSearch, SearchField } from "../src/ui/Search";
import { Segmented } from "../src/ui/Segmented";
import { StatusGlyph } from "../src/ui/TaskGlyphs";
import { showToast } from "../src/ui/Toast";
import { Toggle } from "../src/ui/Toggle";
import {
  CONTENT_MAX_WIDTH,
  gutter,
  radius,
  space,
  type ColorToken,
  type TypeRole,
  type as typeScale,
  useTheme,
  type Appearance,
} from "../src/ui/theme";

const ROLES: TypeRole[] = [
  "largeTitle",
  "title",
  "headline",
  "body",
  "prose",
  "callout",
  "subhead",
  "label",
  "footnote",
  "sectionHeader",
  "caption",
  "code",
];
const SWATCHES: ColorToken[] = [
  "background",
  "grouped",
  "surface",
  "card",
  "raised",
  "ink",
  "secondary",
  "muted",
  "line",
  "accent",
  "accentSoft",
  "prominent",
  "positive",
  "negative",
  "negativeSoft",
  "warning",
  "warningSoft",
];
const PHASES: StatusPhase[] = ["queued", "idle", "working", "waiting", "done", "failed", "stopped"];

function Section({ title, children }: PropsWithChildren<{ title: string }>) {
  return (
    <View>
      <SectionHeader title={title} />
      {children}
    </View>
  );
}

function ChromeDemo() {
  const { colors } = useTheme();
  const scrollY = useSharedValue(0);
  return (
    <View style={{ height: 220, borderRadius: radius.md, overflow: "hidden", backgroundColor: colors.background, borderWidth: 0.5, borderColor: colors.line }}>
      <ChromeProvider>
        <ChromeInner scrollY={scrollY} />
      </ChromeProvider>
    </View>
  );
}
function ChromeInner({ scrollY }: { scrollY: ReturnType<typeof useSharedValue<number>> }) {
  const insets = useChromeInsets();
  return (
    <>
      <ScrollView
        nestedScrollEnabled
        onScroll={(e) => scrollY.set(e.nativeEvent.contentOffset.y)}
        scrollEventThrottle={16}
        contentContainerStyle={{ paddingTop: insets.top, paddingBottom: insets.bottom, padding: space.lg, gap: space.sm }}
      >
        {Array.from({ length: 12 }, (_, i) => (
          <T key={i} variant="subhead" tone="secondary">
            Content line {i + 1} scrolls under the bars.
          </T>
        ))}
      </ScrollView>
      <ChromeBar edge="top" scrollY={scrollY} safeArea={false}>
        <View style={{ height: 44, flexDirection: "row", alignItems: "center", paddingHorizontal: space.sm }}>
          <IconButton name="chevron.left" label="Back" onPress={() => {}} />
          <T variant="headline" style={{ flex: 1 }}>
            Top ChromeBar
          </T>
          <IconButton name="ellipsis" label="More" onPress={() => {}} />
        </View>
      </ChromeBar>
      <ChromeBar edge="bottom" safeArea={false}>
        <View style={{ padding: space.sm, paddingHorizontal: space.lg }}>
          <T variant="footnote" tone="secondary">
            Bottom bar · measured {insets.top} / {insets.bottom} pt
          </T>
        </View>
      </ChromeBar>
    </>
  );
}

export default function DevKit() {
  const { colors, appearance, setAppearance } = useTheme();
  const { width } = useWindowDimensions();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"all" | "working" | "pinned" | "archived">("all");
  const [effort, setEffort] = useState("Medium");
  const [model, setModel] = useState("opus");
  const [toggle, setToggle] = useState(true);
  const [open, setOpen] = useState(true);
  const [status, setStatus] = useState("To do");
  const [code, setCode] = useState("");
  if (!__DEV__) return <Redirect href="/" />;
  const noteItems: MenuItem[] = [
    { title: "Pin", icon: "pin", onPress: () => showToast("Pinned") },
    { title: "Move to…", icon: "folder", onPress: () => showToast("Move") },
    { title: "Copy as Markdown", icon: "doc.on.doc", onPress: () => showToast("Copied as Markdown") },
    { title: "Share…", icon: "square.and.arrow.up", onPress: () => showToast("Share") },
    { title: "Delete", icon: "trash", destructive: true, onPress: () => showToast("Note deleted", { title: "Undo", icon: "arrow.uturn.backward", onPress: () => {} }) },
  ];
  const statusItems: MenuItem[] = ["Inbox", "To do", "Running", "Needs review", "Done", "Canceled"].map((title) => ({
    title,
    checked: title === status,
    onPress: () => setStatus(title),
  }));
  const taskItems: MenuItem[] = [
    { title: "Mark done", icon: "checkmark.circle", onPress: () => setStatus("Done") },
    { title: "Status", icon: "circle.lefthalf.filled", children: statusItems },
    { title: "Priority", icon: "chart.bar", children: ["Urgent", "High", "Medium", "Low", "No priority"].map((title) => ({ title, checked: title === "High", onPress: () => {} })) },
    { title: "Send to agent…", icon: "paperplane", onPress: () => {} },
    { title: "Delete task", icon: "trash", destructive: true, onPress: () => {} },
  ];
  const effortItems: MenuItem[] = ["Low", "Medium", "High", "Max"].map((title) => ({
    title,
    checked: title === effort,
    onPress: () => setEffort(title),
  }));
  const roles: ButtonRole[] = ["prominent", "tinted", "plain", "destructive"];
  return (
    <View style={{ flex: 1, backgroundColor: colors.grouped }}>
      <Stack.Screen options={{ title: "Design kit", headerLargeTitleEnabled: true }} />
      <HeaderActions
        buttons={[{ title: "Edit", onPress: () => showToast("Edit") }]}
        menu={{ label: "Kit options", items: taskItems }}
      />
      <ListSearch value={query} onChangeText={setQuery} placeholder="Search the kit" />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingHorizontal: gutter(width),
          paddingBottom: 120,
          width: "100%",
          maxWidth: CONTENT_MAX_WIDTH,
          alignSelf: "center",
        }}
      >
        <SectionHeader title="Appearance" first />
        <Segmented<Appearance>
          label="Appearance"
          value={appearance}
          onChange={setAppearance}
          options={[
            { value: "system", label: "System" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
        />

        <Section title="List scope filter (compact)">
          <Segmented
            compact
            label="Show threads"
            value={scope}
            onChange={setScope}
            options={[
              { value: "all", label: "All" },
              { value: "working", label: "Working" },
              { value: "pinned", label: "Pinned" },
              { value: "archived", label: "Archived" },
            ]}
          />
        </Section>

        <Section title="Inset group">
          <InsetGroup>
            <ListRow leading="gearshape" title="Push row" chevron onPress={() => {}} />
            <ListRow leading="slider.horizontal.3" title="Reasoning effort" value={effort} valueMenu={effortItems} />
            <ListRow leading="lock.shield" title="Toggle row" trailing={<Toggle value={toggle} onValueChange={setToggle} />} />
            <ListRow leading="clock" title="With meta" subtitle="Subtitle in subhead secondary, wrapping to a second line when it needs to." meta="3m" onPress={() => {}} />
            <ListRow leading="trash" title="Delete project" destructive onPress={() => confirm({ title: "Remove “kybern” from Kybern?", message: "Its threads stay on your computer.", confirm: "Remove project", onConfirm: () => showToast("Removed") })} />
          </InsetGroup>
          <SectionFooter inset>A footer explains the group in footnote muted.</SectionFooter>
        </Section>

        <Section title="Selectable rows (model picker)">
          <InsetGroup>
            {[
              { id: "default", title: "Agent default" },
              { id: "opus", title: "Claude Opus 5.5", subtitle: "For complex work and everyday tasks" },
              { id: "fable", title: "Claude Fable 5.1", subtitle: "For your toughest challenges" },
            ].map((m) => (
              <ListRow
                key={m.id}
                leading={<ProviderMark kind="claude-code" size={20} />}
                title={m.title}
                subtitle={m.subtitle}
                checked={model === m.id}
                onPress={() => setModel(m.id)}
              />
            ))}
          </InsetGroup>
        </Section>

        <View>
          <SectionHeader title="Global" count={3} action={{ title: "New", label: "New global note", onPress: () => showToast("New note") }} />
          <SectionHeader title="Recently deleted" count={2} open={open} onToggle={() => setOpen(!open)} />
          <DisclosureRow title="Thread notes" count={4} open={open} onToggle={() => setOpen(!open)} />
        </View>

        <Section title="Plain list · long-press, swipe">
          <View style={{ backgroundColor: colors.background, borderRadius: radius.md, overflow: "hidden" }}>
            <ListRow
              title="Project brief"
              subtitle="Long-press for the note menu"
              meta="11d"
              onPress={() => {}}
              menu={noteItems}
              swipe={{
                leading: [{ title: "Pin", icon: "pin", tone: "accent", onPress: () => showToast("Pinned") }],
                trailing: [{ title: "Delete", icon: "trash", tone: "negative", full: true, onPress: () => showToast("Note deleted", { title: "Undo", onPress: () => {} }) }],
              }}
            />
            <ListSeparator />
            <ListRow
              leading={<StatusGlyph status="todo" size={16} />}
              title="Fix recurring bug"
              subtitle="ADE-12 · kybern"
              meta="3h"
              onPress={() => {}}
              menu={taskItems}
              menuTitle="ADE-12 · Fix recurring bug"
              swipe={{
                leading: [{ title: "Done", icon: "checkmark", tone: "positive", full: true, onPress: () => setStatus("Done") }],
                trailing: [
                  { title: "Archive", icon: "archivebox", tone: "neutral", onPress: () => showToast("Archived") },
                  { title: "Delete", icon: "trash", tone: "negative", full: true, onPress: () => showToast("Deleted") },
                ],
              }}
            />
          </View>
        </Section>

        <Section title="Menus">
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
            <MenuButton label="Task options" title="ADE-12 · Fix recurring bug" items={taskItems} />
            <MenuButton label={`Status, ${status}`} title="Status" items={statusItems}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: space.sm }}>
                <T variant="body" tone="secondary">
                  {status}
                </T>
                <Icon name="chevron.up.chevron.down" size={13} color={colors.muted} />
              </View>
            </MenuButton>
          </View>
          <ContextMenu items={noteItems} title="Custom row" surface={colors.surface} radius={radius.md}>
            {({ onLongPress }) => (
              <Tap
                label="Custom row with a context menu"
                feedback="highlight"
                onLongPress={onLongPress}
                onPress={() => {}}
                style={{ marginTop: space.sm, padding: space.lg, borderRadius: radius.md, backgroundColor: colors.surface }}
              >
                <T variant="subhead">Any row can be a ContextMenu trigger (long-press)</T>
              </Tap>
            )}
          </ContextMenu>
        </Section>

        <Section title="Buttons">
          <View style={{ gap: space.sm }}>
            {roles.map((role) => (
              <View key={role} style={{ flexDirection: "row", gap: space.sm, alignItems: "center" }}>
                <View style={{ flex: 1 }}>
                  <Button role={role} icon={role === "destructive" ? "trash" : undefined} onPress={() => {}}>
                    {role[0]!.toUpperCase() + role.slice(1)}
                  </Button>
                </View>
                <Button role={role} size="medium" onPress={() => {}}>
                  Medium
                </Button>
              </View>
            ))}
            <Button role="prominent" busy onPress={() => {}}>
              Busy
            </Button>
            <Button disabled onPress={() => {}}>
              Disabled
            </Button>
          </View>
        </Section>

        <Section title="Fields and search">
          <View style={{ gap: space.md }}>
            <SearchField value={query} onChangeText={setQuery} placeholder="Search notes" />
            <Field label="Computer address" placeholder="100.64.0.2:4173" autoCapitalize="none" />
            <Field label="Pairing code" variant="code" placeholder="000000" value={code} onChangeText={setCode} maxLength={6} />
            <Field label="With an error" placeholder="Name" error="Enter a name to continue." />
          </View>
        </Section>

        <Section title="Feedback">
          <View style={{ gap: space.sm }}>
            <ErrorBanner error="Unable to connect. Check that Kybern is running on your computer, then try again." onRetry={() => {}} />
            <Button onPress={() => showToast("Note deleted", { title: "Undo", icon: "arrow.uturn.backward", onPress: () => {} })}>Show toast</Button>
            <Button role="destructive" onPress={() => confirm({ title: "Delete “Project brief” forever?", message: "This can’t be undone.", confirm: "Delete forever", onConfirm: () => {} })}>
              Delete forever…
            </Button>
            <Button onPress={() => router.push("/dev-sheet")}>Open a sheet</Button>
          </View>
        </Section>

        <Section title="Status vocabulary">
          <InsetGroup>
            {PHASES.map((phase) => {
              const info = phase === "waiting" ? taskStatus("needs_review") : phase === "working" ? runtimeStatus("running") : { word: phase[0]!.toUpperCase() + phase.slice(1), tone: "secondary" as const };
              return (
                <ListRow
                  key={phase}
                  leading={<StatusGlyph phase={phase} size={16} animated={phase === "working"} />}
                  title={info.word}
                  meta={phase}
                />
              );
            })}
          </InsetGroup>
          <SectionFooter>
            {`${count(1, "helper")} · ${count(3, "helper")} · ${plural(2, { one: "{n} needs you", other: "{n} need you" })} · ${count(1, "process", "processes")}`}
          </SectionFooter>
        </Section>

        <Section title="Empty states">
          <View style={{ backgroundColor: colors.background, borderRadius: radius.md }}>
            <Empty icon="doc.text" title="No notes yet" detail="Notes you write here sync with your computer." action={<Button size="medium" onPress={() => {}}>New note</Button>} />
          </View>
          <InsetGroup style={{ marginTop: space.sm }}>
            <Empty variant="inline" title="No global notes yet." />
          </InsetGroup>
        </Section>

        <Section title="Chrome bars">
          <ChromeDemo />
        </Section>

        <Section title="Type scale">
          <View style={{ gap: space.sm }}>
            {ROLES.map((role) => (
              <T key={role} variant={role} numberOfLines={1}>
                {role} {typeScale[role].fontSize}/{typeScale[role].lineHeight}
              </T>
            ))}
          </View>
        </Section>

        <Section title="Colors">
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
            {SWATCHES.map((token) => (
              <View key={token} style={{ width: 96, gap: space.xs }}>
                <View style={{ height: 40, borderRadius: radius.sm, backgroundColor: colors[token], borderWidth: 0.5, borderColor: colors.line }} />
                <T variant="caption" tone="secondary">
                  {token}
                </T>
              </View>
            ))}
          </View>
        </Section>
      </ScrollView>
    </View>
  );
}
