import { useCallback, useEffect, useRef, useState } from "react";
import { Keyboard, Linking, ScrollView, TextInput, View } from "react-native";
import { connectorLoginOutput } from "../../../../packages/kybern-client/src/connectorLogin";
import { Alert } from "../ui/Alert";
import { WebView } from "react-native-webview";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../ui/theme";
import { terminalEdit } from "../lib/terminalInput";
import terminalHtml from "../generated/terminal.json";
import {
  type TerminalInfo,
  type TerminalOutputNotification,
} from "../state/protocol";
import { currentClient, errorText, rpc, useApp } from "../state/runtime";
import {
  Button,
  ErrorBanner,
  Field,
  Icon,
  IconButton,
  T,
  Tap,
  styles,
} from "../ui/primitives";
import { MenuButton, type MenuItem } from "../ui/ActionMenu";
import { ProviderMark } from "../ui/ProviderMark";
import { SearchField } from "../ui/Search";
import { radius, space } from "../ui/theme";

function base64(text: string) {
  const bytes = new TextEncoder().encode(text);
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw);
}
export function Terminal({ threadId, initialTerminalId, connectorLogin = false, embedded = false }: { threadId: string; initialTerminalId?: string; connectorLogin?: boolean; embedded?: boolean }) {
  const app = useApp();
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [selected, setSelected] = useState(initialTerminalId ?? "");
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [redirect, setRedirect] = useState("");
  const { colors, dark } = useTheme();
  const insets = useSafeAreaInsets();
  const [keyboard, setKeyboard] = useState(false);
  const [control, setControl] = useState(false);
  const controlRef = useRef(false);
  controlRef.current = control;
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", () =>
      setKeyboard(true),
    );
    const hide = Keyboard.addListener("keyboardDidHide", () =>
      setKeyboard(false),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [hit, setHit] = useState({ index: 0, total: 0 });
  // Agent CLIs installed on the computer open as their own terminal tab (desktop parity).
  const clis = app.providers.filter((p) => p.available && p.binary_path);
  const launchItems: MenuItem[] = [
    { title: "Shell", icon: "terminal", onPress: () => void create() },
    ...clis.map((p) => ({
      title: p.display_name,
      subtitle: "Agent CLI",
      icon: "sparkle" as const,
      onPress: () => void create([p.binary_path!]),
    })),
  ];
  const find = (text: string, step: number) =>
    web.current?.injectJavaScript(`window.findInTerminal(${JSON.stringify(text)}, ${step}); true;`);
  const endSearch = () => {
    setSearching(false);
    setQuery("");
    setHit({ index: 0, total: 0 });
    find("", 0);
  };
  const web = useRef<WebView>(null);
  const input = useRef<TextInput>(null);
  const inputQueue = useRef<Promise<unknown>>(Promise.resolve());
  const keyboardTextRef = useRef("");
  const selectedRef = useRef("");
  selectedRef.current = selected;
  const reload = useCallback(async () => {
    const r = await rpc("terminals.list", { thread_id: threadId });
    setError("");
    setTerminals(r.terminals);
    setSelected((s) =>
      r.terminals.some((t) => t.id === s) ? s : (r.terminals[0]?.id ?? ""),
    );
  }, [threadId]);
  useEffect(() => {
    void reload().catch((e) => setError(errorText(e)));
  }, [reload, app.status]);
  useEffect(() => {
    if (!selected || !ready || app.status !== "open") return;
    const client = currentClient();
    if (!client) return;
    let alive = true;
    web.current?.injectJavaScript("window.resetTerminal(); true;");
    const loginOutput = connectorLogin && selected === initialTerminalId ? connectorLoginOutput() : null;
    const off = client.onNotification("terminal.output", (raw) => {
      const event = raw as TerminalOutputNotification;
      if (alive && event.terminal_id === selected) {
        web.current?.injectJavaScript(
          `window.writeOutput(${JSON.stringify(event.data)}); true;`,
        );
        const url = loginOutput?.(event.data);
        if (url) setLoginUrl(url);
      }
    });
    const exit = client.onNotification("terminal.exited", () => {
      if (alive) void reload().catch((e) => setError(errorText(e)));
    });
    const subscribe = () =>
      client
        .call("terminals.subscribe", { terminal_id: selected, replay: true })
        .catch((e) => {
          if (alive) setError(errorText(e));
        });
    // The daemon dropped output this client could not keep up with: redraw from the replay.
    const lagged = client.onNotification("terminal.lagged", (raw) => {
      if (!alive || (raw as { terminal_id?: string }).terminal_id !== selected) return;
      web.current?.injectJavaScript("window.resetTerminal(); true;");
      void subscribe();
    });
    void subscribe();
    return () => {
      alive = false;
      off();
      exit();
      lagged();
      void client
        .call("terminals.unsubscribe", { terminal_id: selected })
        .catch(() => {});
    };
  }, [selected, ready, app.status, reload, connectorLogin, initialTerminalId]);
  useEffect(() => {
    if (ready)
      web.current?.injectJavaScript(
        `window.setTerminalTheme(${JSON.stringify({ background: colors.background, foreground: colors.ink, cursor: colors.accent, selectionBackground: dark ? "#355373" : "#BBD8F9", dark })}); true;`,
      );
  }, [ready, colors, dark]);
  useEffect(() => {
    setControl(false);
    setSearching(false);
    setQuery("");
    setHit({ index: 0, total: 0 });
  }, [selected]);
  async function create(command?: string[]) {
    setBusy(true);
    setError("");
    try {
      const terminal = await rpc("terminals.create", {
        thread_id: threadId,
        cols: 48,
        rows: 24,
        ...(command ? { command } : {}),
      });
      await reload();
      setSelected(terminal.id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function send(text: string) {
    if (!selected) return;
    if (controlRef.current && text.length === 1) {
      const code = text.toUpperCase().charCodeAt(0);
      if (code >= 64 && code <= 95) text = String.fromCharCode(code - 64);
      else if (text === " ") text = "\x00";
      else if (text === "?") text = "\x7f";
      controlRef.current = false;
      setControl(false);
    }
    const client = currentClient();
    if (!client) return;
    const terminalId = selected;
    // The daemon dispatches RPCs concurrently. Keep keystrokes in their original
    // order, including control keys, even when a preceding write awaits the PTY.
    const data = base64(text);
    const write = inputQueue.current
      .catch(() => {})
      .then(() =>
        client.call("terminals.input", { terminal_id: terminalId, data }),
      );
    inputQueue.current = write;
    try {
      await write;
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    }
  }
  async function completeLogin() {
    setBusy(true);
    try { if (await send(redirect.trim() + "\r")) setRedirect(""); }
    finally { setBusy(false); }
  }

  function close() {
    Alert.alert(
      "Close this terminal?",
      "The shell and processes running in it will stop.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Close terminal",
          style: "destructive",
          onPress: () => {
            void rpc("terminals.close", { terminal_id: selected })
              .then(reload)
              .catch((e) => setError(errorText(e)));
          },
        },
      ],
    );
  }
  return (
    <View style={{ flex: 1, gap: 4 }}>
      {!!error && (
        <View style={{ paddingHorizontal: space.lg }}>
          <ErrorBanner error={error} onRetry={() => void reload().catch((e) => setError(errorText(e)))} />
        </View>
      )}
      {connectorLogin && selected === initialTerminalId && <View style={{ paddingHorizontal: 16, gap: 8 }}>
        {loginUrl && <Button onPress={() => void Linking.openURL(loginUrl).catch(e => setError(errorText(e)))}>Sign in on {new URL(loginUrl).hostname}</Button>}
        <T variant="footnote" tone="secondary">After signing in, paste the full redirect URL when Claude asks for it.</T>
        <Field label="Sign-in redirect URL" hideLabel secureTextEntry autoCapitalize="none" autoCorrect={false} value={redirect} onChangeText={setRedirect} placeholder="Paste the redirect URL" />
        <Button busy={busy} disabled={!ready || !redirect.trim() || app.status !== "open"} onPress={() => void completeLogin()}>Complete sign-in</Button>
      </View>}
      {terminals.length > 0 && (
        <View style={[styles.spread, { gap: space.xs, paddingStart: space.lg, paddingEnd: space.xs }]}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: space.xs }}
            keyboardShouldPersistTaps="always"
          >
            {terminals.map((t) => (
              <Tap
                key={t.id}
                label={`${t.title || "Shell"}${t.alive ? "" : ", exited"}`}
                selected={t.id === selected}
                feedback="highlight"
                onPress={() => setSelected(t.id)}
                style={{
                  paddingHorizontal: space.md,
                  borderRadius: radius.full,
                  backgroundColor: selected === t.id ? colors.raised : "transparent",
                }}
              >
                <T variant="code" tone={selected === t.id ? "ink" : "secondary"} numberOfLines={1}>
                  {t.title || "Shell"}
                  {!t.alive ? " · Exited" : ""}
                </T>
              </Tap>
            ))}
          </ScrollView>
          {!!selected && (
            <IconButton
              name="magnifyingglass"
              label={searching ? "Hide search" : "Search scrollback"}
              onPress={() => (searching ? endSearch() : setSearching(true))}
            />
          )}
          <MenuButton icon="plus" label="New terminal" title="Open in a new tab" items={launchItems} disabled={busy || app.status !== "open"} />
          {!!selected && <IconButton name="xmark" label="Close terminal" onPress={close} />}
        </View>
      )}
      {searching && !!selected && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, paddingStart: space.lg, paddingEnd: space.xs }}>
          <View style={{ flex: 1 }}>
            <SearchField
              placeholder="Search scrollback"
              value={query}
              autoFocus
              onChangeText={(text) => {
                setQuery(text);
                find(text, 0);
              }}
              onSubmit={() => find(query, -1)}
            />
          </View>
          <T variant="footnote" tone="muted" style={{ fontVariant: ["tabular-nums"], minWidth: 44, textAlign: "center" }}>
            {query ? (hit.total ? `${hit.index} of ${hit.total}` : "None") : ""}
          </T>
          <IconButton name="chevron.up" label="Previous match" disabled={!hit.total} onPress={() => find(query, -1)} />
          <IconButton name="chevron.down" label="Next match" disabled={!hit.total} onPress={() => find(query, 1)} />
        </View>
      )}
      {!selected ? (
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: space.xl, paddingTop: 40, paddingBottom: space["2xl"] }}
        >
          <View style={{ width: "100%", maxWidth: 480, alignSelf: "center", alignItems: "center", gap: space.sm }}>
            <Icon name="terminal" size={34} color={colors.muted} />
            <T variant="headline" accessibilityRole="header" style={{ textAlign: "center", marginTop: space.xs }}>
              No terminal open
            </T>
            <T variant="subhead" tone="secondary" style={{ textAlign: "center", maxWidth: 300 }}>
              Run commands or an agent CLI in this thread’s workspace.
            </T>
            <View style={{ marginTop: space.md, flexDirection: "row", gap: space.sm }}>
              <Button busy={busy} disabled={app.status !== "open"} size="medium" onPress={() => void create()}>
                Open terminal
              </Button>
              {clis.length > 0 && (
                <MenuButton items={launchItems.slice(1)} title="Agent CLIs on your computer" label="Open an agent CLI" radius={radius.full} disabled={app.status !== "open"}>
                  <View style={{ minHeight: 36, paddingHorizontal: space.md, flexDirection: "row", alignItems: "center", gap: space.xs }}>
                    <T variant="label" tone="accent">Agent CLI</T>
                    <Icon name="chevron.down" size={13} color={colors.accent} />
                  </View>
                </MenuButton>
              )}
            </View>
          </View>
        </ScrollView>
      ) : (
        <>
          <View
            style={{
              flex: 1,
              minHeight: 80,
              overflow: "hidden",
              backgroundColor: colors.background,
            }}
          >
            <WebView
              ref={web}
              source={{ html: terminalHtml, baseUrl: "about:blank" }}
              originWhitelist={["about:blank"]}
              onShouldStartLoadWithRequest={(request) =>
                request.url === "about:blank"
              }
              onLoadStart={() => setReady(false)}
              javaScriptEnabled
              keyboardDisplayRequiresUserAction={false}
              hideKeyboardAccessoryView
              automaticallyAdjustContentInsets={false}
              scrollEnabled={false}
              style={{ backgroundColor: colors.background }}
              onMessage={(event) => {
                try {
                  const message = JSON.parse(event.nativeEvent.data) as {
                    type: string;
                    data?: string;
                    cols?: number;
                    rows?: number;
                    index?: number;
                    total?: number;
                  };
                  if (message.type === "ready") setReady(true);
                  if (message.type === "search")
                    setHit({ index: Number(message.index) || 0, total: Number(message.total) || 0 });
                  if (message.type === "focus") input.current?.focus();
                  if (
                    message.type === "input" &&
                    typeof message.data === "string"
                  )
                    void send(message.data);
                  if (
                    (message.type === "resize" || message.type === "ready") &&
                    selectedRef.current &&
                    Number.isInteger(message.cols) &&
                    Number.isInteger(message.rows)
                  )
                    void rpc("terminals.resize", {
                      terminal_id: selectedRef.current,
                      cols: message.cols!,
                      rows: message.rows!,
                    }).catch((e) => setError(errorText(e)));
                } catch {
                  setError(
                    "Terminal display could not process an update. Reopen this workspace.",
                  );
                }
              }}
            />
          </View>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              paddingHorizontal: 12,
              paddingTop: 8,
              paddingBottom:
                keyboard || embedded ? 8 : Math.max(12, insets.bottom),
            }}
          >
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              keyboardShouldPersistTaps="always"
              contentContainerStyle={{ gap: 8 }}
              style={{ flex: 1 }}
            >
              <View
                style={{
                  flexDirection: "row",
                  backgroundColor: colors.raised,
                  borderRadius: radius.full,
                }}
              >
                <Tap
                  label="Escape"
                  onPress={() => void send("\x1b")}
                  style={{ width: 44, alignItems: "center" }}
                >
                  <T variant="code">esc</T>
                </Tap>
                <Tap
                  label="Control modifier"
                  selected={control}
                  onPress={() => setControl(!control)}
                  style={{
                    width: 48,
                    alignItems: "center",
                    borderRadius: radius.full,
                    backgroundColor: control ? colors.accentSoft : undefined,
                  }}
                >
                  <T variant="code" tone={control ? "accent" : "ink"}>
                    ctrl
                  </T>
                </Tap>
                <Tap
                  label="Tab"
                  onPress={() => void send("\t")}
                  style={{ width: 44, alignItems: "center" }}
                >
                  <T variant="code">tab</T>
                </Tap>
              </View>
              <View
                style={{
                  flexDirection: "row",
                  backgroundColor: colors.raised,
                  borderRadius: radius.full,
                }}
              >
                {["~", "|", "/", "-"].map((value) => (
                  <Tap
                    key={value}
                    label={`Type ${value}`}
                    onPress={() => void send(value)}
                    style={{ width: 44, alignItems: "center" }}
                  >
                    <T variant="mono">{value}</T>
                  </Tap>
                ))}
              </View>
              <View
                style={{
                  flexDirection: "row",
                  backgroundColor: colors.raised,
                  borderRadius: radius.full,
                }}
              >
                {[
                  ["←", "Left arrow", "\x1b[D"],
                  ["↓", "Down arrow", "\x1b[B"],
                  ["↑", "Up arrow", "\x1b[A"],
                  ["→", "Right arrow", "\x1b[C"],
                ].map(([glyph, label, value]) => (
                  <Tap
                    key={label}
                    label={label!}
                    onPress={() => void send(value!)}
                    style={{ width: 44, alignItems: "center" }}
                  >
                    <T>{glyph}</T>
                  </Tap>
                ))}
              </View>
            </ScrollView>
            <View style={{ backgroundColor: colors.raised, borderRadius: radius.full }}>
              <TextInput
                underlineColorAndroid="transparent"
                ref={input}
                accessibilityLabel="Terminal keyboard input"
                defaultValue=""
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                smartInsertDelete={false}
                caretHidden
                contextMenuHidden
                submitBehavior="submit"
                onChangeText={(text) => {
                  const previous = keyboardTextRef.current;
                  const data = terminalEdit(previous, text);
                  keyboardTextRef.current = text;
                  if (data) void send(data);
                }}
                onKeyPress={(event) => {
                  if (
                    event.nativeEvent.key === "Backspace" &&
                    !keyboardTextRef.current
                  )
                    void send("\x7f");
                }}
                onSubmitEditing={() => {
                  void send("\r");
                  keyboardTextRef.current = "";
                  input.current?.clear();
                }}
                style={{
                  position: "absolute",
                  width: 44,
                  height: 44,
                  color: "transparent",
                  fontSize: 1,
                }}
              />
              <IconButton
                name={keyboard ? "keyboard.chevron.compact.down" : "keyboard"}
                label={keyboard ? "Hide keyboard" : "Show keyboard"}
                onPress={() => {
                  if (keyboard) {
                    input.current?.blur();
                    Keyboard.dismiss();
                  } else input.current?.focus();
                }}
              />
            </View>
          </View>
        </>
      )}
    </View>
  );
}
