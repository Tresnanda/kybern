// Resume a session another coding agent saved on the computer.
import { router, Stack } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { Section } from "../src/features/settings/common";
import { type ProviderKind, type SavedSession } from "../src/state/protocol";
import { homeOf, shortPath } from "../src/state/projectList";
import { currentClient, errorText, refresh, rpc, useApp } from "../src/state/runtime";
import { relativeTime } from "../src/state/threadList";
import { ListRow } from "../src/ui/List";
import { Button, Empty, ErrorBanner, Page } from "../src/ui/primitives";
import { ProviderMark } from "../src/ui/ProviderMark";
import { ListSearch } from "../src/ui/Search";
import { space, useTheme } from "../src/ui/theme";
import { Working } from "../src/ui/Working";

export default function Sessions() {
  const app = useApp();
  const { colors } = useTheme();
  const [provider, setProvider] = useState<ProviderKind>(
    () => app.providers.find((p) => p.available)?.kind ?? "claude-code",
  );
  const [query, setQuery] = useState("");
  const [sessions, setSessions] = useState<SavedSession[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const agent = app.providers.find((p) => p.kind === provider);
  const unavailable = agent && !agent.available;
  useEffect(() => {
    if (unavailable) {
      setSessions([]);
      setCursor(null);
      return;
    }
    let alive = true;
    setBusy(true);
    const timer = setTimeout(() => {
      rpc("sessions.list", { provider, query: query || undefined })
        .then((r) => {
          if (!alive) return;
          setSessions(r.sessions);
          setCursor(r.next_cursor);
          setError("");
        })
        .catch((e) => alive && setError(errorText(e)))
        .finally(() => alive && setBusy(false));
    }, 200);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [provider, query, unavailable]);
  async function resume(session: SavedSession) {
    setBusy(true);
    try {
      const t = await rpc("sessions.resume", { provider: session.provider, session_id: session.id });
      await refresh();
      router.replace({ pathname: "/thread/[id]", params: { id: t.id } });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const more = () => {
    if (!cursor) return;
    setBusy(true);
    rpc("sessions.list", { provider, query: query || undefined, cursor })
      .then((r) => {
        setSessions((s) => [...s, ...r.sessions]);
        setCursor(r.next_cursor);
      })
      .catch((e) => setError(errorText(e)))
      .finally(() => setBusy(false));
  };
  return (
    <Page grouped>
      <Stack.Screen options={{ headerStyle: { backgroundColor: colors.grouped } }} />
      <ListSearch value={query} onChangeText={setQuery} placeholder="Search title or project" />
      <Section first footer="Continue work you started in another coding agent.">
        <ListRow
          title="Agent"
          leading={<ProviderMark kind={provider} size={20} />}
          value={agent?.display_name ?? provider}
          valueMenu={app.providers.map((p) => ({
            title: p.display_name,
            subtitle: p.available ? undefined : (p.unavailable_reason ?? "Not set up on your computer"),
            checked: p.kind === provider,
            onPress: () => setProvider(p.kind),
          }))}
        />
      </Section>
      <ErrorBanner error={error} />
      {unavailable ? (
        <Empty
          icon="exclamationmark.circle"
          title={`${agent.display_name} isn't set up`}
          detail={agent.unavailable_reason ?? `Install ${agent.display_name} on your computer to resume its sessions.`}
        />
      ) : busy && !sessions.length ? (
        <View style={{ marginVertical: space.xl }}>
          <Working label="Loading sessions" />
        </View>
      ) : !sessions.length ? (
        <Empty
          icon="clock"
          title={query ? `No sessions match “${query}”` : "No sessions yet"}
          detail={query ? "Try another title or project." : `Sessions ${agent?.display_name ?? "this agent"} saves on your computer show up here.`}
        />
      ) : (
        <Section title="Sessions">
          {sessions.map((s) => (
            <ListRow
              key={s.id}
              title={s.title || "Untitled session"}
              subtitle={shortPath(s.cwd, homeOf(currentClient()?.info?.data_dir))}
              subtitleLines={1}
              meta={Number.isFinite(Date.parse(s.updated_at)) ? relativeTime(s.updated_at) : undefined}
              disabled={busy}
              onPress={() => void resume(s)}
            />
          ))}
        </Section>
      )}
      {cursor && !unavailable ? (
        <View style={{ marginTop: space.md }}>
          <Button role="plain" busy={busy} onPress={more}>
            Show more sessions
          </Button>
        </View>
      ) : null}
    </Page>
  );
}
