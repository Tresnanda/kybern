import { router } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { type ProviderKind, type SavedSession } from "../src/state/protocol";
import { errorText, refresh, rpc, useApp } from "../src/state/runtime";
import {
  Button,
  Empty,
  ErrorBanner,
  Field,
  Page,
  Row,
  T,
  Tap,
} from "../src/ui/primitives";
import { ProviderMark } from "../src/ui/ProviderMark";
import { useTheme } from "../src/ui/theme";
import { Working } from "../src/ui/Working";
export default function Sessions() {
  const app = useApp();
  const { colors } = useTheme();
  const [provider, setProvider] = useState<ProviderKind>("claude-code");
  const [query, setQuery] = useState("");
  const [sessions, setSessions] = useState<SavedSession[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    setBusy(true);
    const timer = setTimeout(() => {
      void rpc("sessions.list", { provider, query: query || undefined })
        .then((r) => {
          if (alive) {
            setSessions(r.sessions);
            setCursor(r.next_cursor);
            setError("");
          }
        })
        .catch((e) => {
          if (alive) setError(errorText(e));
        })
        .finally(() => {
          if (alive) setBusy(false);
        });
    }, 200);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [provider, query]);
  async function resume(session: SavedSession) {
    setBusy(true);
    try {
      const t = await rpc("sessions.resume", {
        provider: session.provider,
        session_id: session.id,
      });
      await refresh();
      router.replace({ pathname: "/thread/[id]", params: { id: t.id } });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Page>
      <T tone="secondary" style={{ marginBottom: 24 }}>
        Continue work you started in another coding agent.
      </T>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 8,
          marginBottom: 20,
        }}
      >
        {app.providers.map((p) => (
          <Tap
            key={p.kind}
            label={p.display_name}
            onPress={() => setProvider(p.kind)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              paddingHorizontal: 14,
              borderRadius: 22,
              backgroundColor: provider === p.kind ? colors.ink : colors.raised,
            }}
          >
            <ProviderMark
              kind={p.kind}
              size={17}
              color={provider === p.kind ? colors.inverse : colors.ink}
            />
            <T
              variant="caption"
              tone={provider === p.kind ? "inverse" : "secondary"}
            >
              {p.display_name}
            </T>
          </Tap>
        ))}
      </View>
      <Field
        label="Find a session"
        value={query}
        onChangeText={setQuery}
        placeholder="Search title or project"
      />
      <ErrorBanner error={error} />
      {busy && (
        <View style={{ marginVertical: 20 }}>
          <Working label="Loading sessions" />
        </View>
      )}
      {sessions.map((s) => (
        <Row
          key={s.id}
          title={s.title || "Untitled session"}
          detail={s.cwd}
          icon="clock.arrow.circlepath"
          onPress={() => void resume(s)}
        />
      ))}
      {!busy && !sessions.length && (
        <Empty
          icon="clock"
          title="No sessions here yet."
          detail="Sessions saved by this agent on your computer will appear here."
        />
      )}
      {cursor && (
        <Button
          secondary
          busy={busy}
          onPress={() => {
            setBusy(true);
            void rpc("sessions.list", {
              provider,
              query: query || undefined,
              cursor,
            })
              .then((r) => {
                setSessions((s) => [...s, ...r.sessions]);
                setCursor(r.next_cursor);
              })
              .catch((e) => setError(errorText(e)))
              .finally(() => setBusy(false));
          }}
        >
          Load more sessions
        </Button>
      )}
    </Page>
  );
}
