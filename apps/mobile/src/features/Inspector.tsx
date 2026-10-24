import { useEffect, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { DURATION, PANE } from "../components/liquid/motion";
import { type InspectorTab, useLayout } from "../state/layout";
import { useApp, useThread } from "../state/runtime";
import { Changes } from "./Changes";
import { Files } from "./Files";
import { Terminal } from "./Terminal";
import { AgentsList, useAgents, type AgentsSegment } from "./AgentsSheet";
import { Empty, Icon, IconButton, styles, T, Tap } from "../ui/primitives";
import type { IconName } from "../ui/icons";
import { useTheme } from "../ui/theme";

const TABS: { key: InspectorTab; label: string; icon: IconName }[] = [
  { key: "changes", label: "Changes", icon: "arrow.triangle.branch" },
  { key: "files", label: "Files", icon: "folder" },
  { key: "terminal", label: "Terminal", icon: "terminal" },
  { key: "tasks", label: "Agents", icon: "person.2" },
];

// The right dock, mirroring the desktop RightPanel: a tab strip over Changes /
// Files / Terminal / Tasks panes. Panes are mounted lazily on first visit and
// then kept mounted (toggled by opacity, never unmounted) so the terminal's
// WebView session and each pane's scroll/selection survive tab switches.
function Inspector({ threadId }: { threadId: string }) {
  const app = useApp();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { inspectorTab, setInspectorTab, closeInspector } = useLayout();
  const snapshot = useThread(threadId);
  const thread = app.threads.find((t) => t.id === threadId) ?? snapshot.thread;
  const project = app.projects.find((p) => p.id === thread?.project_id);

  const [seen, setSeen] = useState<Set<InspectorTab>>(
    () => new Set([inspectorTab]),
  );
  useEffect(() => {
    setSeen((prev) =>
      prev.has(inspectorTab) ? prev : new Set(prev).add(inspectorTab),
    );
  }, [inspectorTab]);

  const [stripWidth, setStripWidth] = useState(0);
  const seg = stripWidth / TABS.length;
  const index = Math.max(
    0,
    TABS.findIndex((t) => t.key === inspectorTab),
  );
  const pillX = useSharedValue(0);
  useEffect(() => {
    pillX.value = withSpring(index * seg, PANE);
  }, [index, seg, pillX]);
  const pill = useAnimatedStyle(() => ({
    width: seg,
    transform: [{ translateX: pillX.value }],
  }));

  const agents = useAgents(thread, snapshot.tasks, { active: inspectorTab === "tasks", live: inspectorTab === "tasks" });
  const [segment, setSegment] = useState<AgentsSegment>("agents");

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colors.background,
        borderLeftWidth: 0.5,
        borderColor: colors.line,
      }}
    >
      <View
        style={{
          paddingTop: insets.top + 8,
          paddingBottom: 8,
          paddingStart: 10,
          paddingEnd: 6,
          ...styles.line,
          gap: 8,
        }}
      >
        <View
          onLayout={(e) => setStripWidth(e.nativeEvent.layout.width)}
          style={{ flex: 1, height: 38, justifyContent: "center" }}
        >
          {seg > 0 && (
            <Animated.View
              style={[
                {
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  borderRadius: 11,
                  backgroundColor: colors.raised,
                },
                pill,
              ]}
            />
          )}
          <View style={{ flexDirection: "row" }}>
            {TABS.map((tab) => {
              const active = tab.key === inspectorTab;
              return (
                <Tap
                  key={tab.key}
                  label={tab.label}
                  selected={active}
                  static
                  onPress={() => setInspectorTab(tab.key)}
                  style={{
                    flex: 1,
                    height: 38,
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 6,
                  }}
                >
                  <Icon
                    name={tab.icon}
                    size={15}
                    color={active ? colors.ink : colors.secondary}
                  />
                  <T variant="footnote" tone={active ? "ink" : "secondary"}>
                    {tab.label}
                  </T>
                </Tap>
              );
            })}
          </View>
        </View>
        <IconButton
          name="xmark"
          label="Hide inspector"
          onPress={closeInspector}
        />
      </View>
      <View style={{ flex: 1 }}>
        {TABS.map((tab) => {
          if (!seen.has(tab.key)) return null;
          const active = tab.key === inspectorTab;
          return (
            <View
              key={tab.key}
              // Panes stay mounted; only the active one is visible and interactive.
              // Never conditionally render the terminal away — it would drop its PTY.
              pointerEvents={active ? "auto" : "none"}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                opacity: active ? 1 : 0,
                zIndex: active ? 1 : 0,
              }}
            >
              {tab.key === "changes" && (
                <ScrollView
                  contentContainerStyle={{
                    padding: 16,
                    paddingBottom: insets.bottom + 24,
                  }}
                  keyboardShouldPersistTaps="handled"
                >
                  <Changes threadId={threadId} />
                </ScrollView>
              )}
              {tab.key === "files" &&
                (project ? (
                  <Files project={project} threadId={threadId} />
                ) : (
                  <View style={{ padding: 16 }}>
                    <Empty
                      icon="folder"
                      title="No project"
                      detail="This thread is not attached to a project folder."
                    />
                  </View>
                ))}
              {tab.key === "terminal" && (
                <Terminal threadId={threadId} embedded />
              )}
              {tab.key === "tasks" && (
                <ScrollView
                  contentContainerStyle={{
                    padding: 16,
                    paddingBottom: insets.bottom + 24,
                  }}
                >
                  <AgentsList threadId={threadId} model={agents} segment={segment} onSegment={setSegment} />
                </ScrollView>
              )}
            </View>
          );
        })}
      </View>
    </View>
  );
}

// The column on wide layouts (ux-thread M11). The inspector is an absolute layer that
// slides with translateX on the PANE spring; the conversation's width changes once —
// as the inspector starts to open, and after it has finished closing — so the
// transcript and its Markdown never re-lay-out on every frame. The inspector is
// mounted on first open and then kept mounted so reopening (and any running
// terminal) is instant.
export function InspectorColumn({ threadId }: { threadId: string }) {
  const { regular, inspectorOpen, inspectorWidth } = useLayout();
  const reduced = useReducedMotion();
  const shown = regular && inspectorOpen;
  const opened = useRef(false);
  if (shown) opened.current = true;
  const [committed, setCommitted] = useState(shown);
  const progress = useSharedValue(shown ? 1 : 0);
  useEffect(() => {
    if (shown) setCommitted(true);
    const done = (finished?: boolean) => {
      "worklet";
      if (finished && !shown) scheduleOnRN(setCommitted, false);
    };
    progress.value = reduced
      ? withTiming(shown ? 1 : 0, { duration: DURATION.enter }, done)
      : withSpring(shown ? 1 : 0, PANE, done);
  }, [shown, progress, reduced]);
  const content = useAnimatedStyle(() =>
    reduced
      ? { opacity: progress.value }
      : { transform: [{ translateX: (1 - progress.value) * inspectorWidth }] },
  );
  return (
    <View style={{ width: committed ? inspectorWidth : 0, overflow: "hidden" }}>
      {opened.current ? (
        <Animated.View
          pointerEvents={shown ? "auto" : "none"}
          style={[{ position: "absolute", top: 0, bottom: 0, end: 0, width: inspectorWidth }, content]}
        >
          <Inspector threadId={threadId} />
        </Animated.View>
      ) : null}
    </View>
  );
}
