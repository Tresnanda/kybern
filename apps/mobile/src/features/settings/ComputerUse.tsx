// Computer use: whether agents may use apps on the computer, how, which apps
// they may use without asking, what they learned about each app, and a live view.
import { router } from "expo-router";
import { useEffect } from "react";
import type { ComputerUseSettings } from "../../state/protocol";
import { loadComputerUse, saveComputerNote, useComputerUse } from "../../state/computerUse";
import { errorText, threadHasActivity, useApp } from "../../state/runtime";
import { saveSettings, useSettings } from "../../state/settings";
import { ListRow } from "../../ui/List";
import { Empty, ErrorBanner } from "../../ui/primitives";
import { showToast } from "../../ui/Toast";
import { Section, ToggleRow, WithSettings } from "./common";

export function ComputerUseSettingsPage() {
  return (
    <WithSettings>
      <ComputerUseBody />
    </WithSettings>
  );
}

const PERMISSION = { granted: "Allowed", missing: "Not allowed", unknown: "Unknown" } as const;

function ComputerUseBody() {
  const app = useApp();
  const { settings: current } = useSettings();
  const settings = current!;
  const { status, notes, error } = useComputerUse();
  useEffect(() => {
    void loadComputerUse();
  }, [app.activeId, settings.computer_use.enabled]);
  const computer = settings.computer_use;
  const update = (patch: Partial<ComputerUseSettings>) =>
    void saveSettings({ ...settings, computer_use: { ...computer, ...patch } });
  const allowed = computer.always_allowed_apps ?? [];
  const running = app.threads.filter((t) => threadHasActivity(t, app.activity) && t.provider.kind !== "codex");
  const unsupported = status && !status.supported;
  const problems = status?.checks.filter((check) => !check.ok) ?? [];
  const removeApp = (name: string) => update({ always_allowed_apps: allowed.filter((item) => item !== name) });
  return (
    <>
      <ErrorBanner error={error} onRetry={() => void loadComputerUse()} />
      <Section
        first
        footer={
          unsupported
            ? "This computer doesn't support computer use."
            : !computer.enabled
              ? "Agents can read an app's window and click and type in it. You approve each app the first time a conversation uses it."
              : status?.ready
                ? "Ready. Ask any agent except Codex to use an app."
                : "Set up on your computer to start: Kybern needs CuaDriver and two macOS permissions."
        }
      >
        <ToggleRow
          title="Let agents use apps"
          value={computer.enabled}
          disabled={!!unsupported}
          onChange={(value) => update({ enabled: value })}
        />
      </Section>
      {computer.enabled ? (
        <>
          <Section title="Status" footer={problems.length ? problems.map((p) => p.fix ?? p.message).join(" ") : null}>
            <ListRow title="CuaDriver" value={!status ? "Checking…" : status.installed ? (status.version ? `Version ${status.version}` : "Installed") : "Not installed"} />
            {status?.installed ? <ListRow title="Accessibility" value={PERMISSION[status.accessibility]} /> : null}
            {status?.installed ? <ListRow title="Screen Recording" value={PERMISSION[status.screen_recording]} /> : null}
          </Section>
          <Section
            title="How agents work"
            footer="Agents work in the background and leave your cursor alone unless they ask to take over for an app. Showing the agent's cursor uses much more memory."
          >
            <ListRow
              title="Your cursor and keyboard"
              value={computer.foreground === "never" ? "Never" : "Ask first"}
              valueMenu={[
                { title: "Ask first", checked: computer.foreground !== "never", onPress: () => update({ foreground: "ask" }) },
                { title: "Never", checked: computer.foreground === "never", onPress: () => update({ foreground: "never" }) },
              ]}
            />
            <ToggleRow title="Show the agent's cursor" value={computer.show_cursor ?? false} onChange={(value) => update({ show_cursor: value })} />
          </Section>
          <Section
            title="Allowed without asking"
            footer={allowed.length ? "They still ask before taking over your cursor. Swipe an app to remove it." : null}
          >
            {allowed.length === 0 ? (
              <Empty variant="inline" title="None yet. Choose “Always allow” when an agent asks to use an app." />
            ) : (
              allowed.map((name) => (
                <ListRow
                  key={name}
                  title={name}
                  menu={[{ title: "Remove", icon: "trash", destructive: true, onPress: () => removeApp(name) }]}
                  swipe={{ trailing: [{ title: "Remove", icon: "trash", tone: "negative", full: true, onPress: () => removeApp(name) }] }}
                />
              ))
            )}
          </Section>
          <Section title="Watch live" footer={running.length ? "See what an agent sees while it uses an app." : "Nothing is running right now."}>
            {running.slice(0, 6).map((thread) => (
              <ListRow
                key={thread.id}
                title={thread.title || "Untitled thread"}
                leading="display"
                chevron
                onPress={() => router.push({ pathname: "/computer-live", params: { threadId: thread.id } })}
              />
            ))}
          </Section>
        </>
      ) : null}
      <Section
        title="App notes"
        footer={notes?.length ? "What agents learned about each app. Later sessions see these as hints." : null}
      >
        {notes === null ? null : notes.length === 0 ? (
          <Empty variant="inline" title="No app notes yet." />
        ) : (
          notes.map((note) => (
            <ListRow
              key={note.bundle_id}
              title={note.app}
              subtitle={note.text.replace(/\s+/g, " ").trim()}
              subtitleLines={2}
              chevron
              onPress={() => router.push({ pathname: "/computer-note", params: { bundleId: note.bundle_id } })}
              menu={[
                {
                  title: "Delete note",
                  icon: "trash",
                  destructive: true,
                  onPress: () =>
                    void saveComputerNote(note, "")
                      .then(() => showToast(`Deleted the note for ${note.app}`))
                      .catch((e) => showToast(`Unable to delete the note. ${errorText(e)}`)),
                },
              ]}
            />
          ))
        )}
      </Section>
    </>
  );
}
