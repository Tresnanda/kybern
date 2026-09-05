import React, { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useConnection } from "@/connection/ConnectionContext";
import { endpointFromForm, parsePairingUrl, redeemPairing } from "@/connection/pairing";
import { Button } from "@/ui/Button";
import { Caption, Screen } from "@/ui/Screen";
import { radius, space, type as t, useTheme } from "@/ui/theme";

export default function ConnectScreen() {
  const th = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ url?: string; token?: string; code?: string; environment?: string }>();
  const { connectTo, endpoint } = useConnection();
  const [url, setUrl] = useState(params.url ?? endpoint?.url ?? "");
  const [token, setToken] = useState(params.token ?? endpoint?.token ?? "");
  const [code, setCode] = useState(params.code ?? "");
  const [environmentId, setEnvironmentId] = useState(params.environment);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onUrlChange = (text: string) => {
    // Pasting a pairing link fills both fields.
    const pairing = parsePairingUrl(text);
    if (pairing) {
      setUrl(pairing.url);
      setToken("");
      setCode(pairing.code);
      setEnvironmentId(pairing.environmentId);
    } else {
      setUrl(text);
      setEnvironmentId(undefined);
    }
  };

  const connect = async () => {
    const ep = endpointFromForm(url, token);
    if (!ep && !code) {
      setError("Enter the daemon address and its token.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await connectTo(code ? await redeemPairing(url, code, environmentId) : ep!);
      router.replace("/threads");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xl }]}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={[t.body, { color: th.textSecondary }]}>
            Connect to a kybern daemon on your network, or open a pairing link from the desktop app.
          </Text>

          <View style={styles.field}>
            <Caption>Daemon address</Caption>
            <TextInput
              accessibilityLabel="Daemon address"
              style={[styles.input, t.mono, { color: th.text, backgroundColor: th.surface }]}
              placeholder="ws://100.64.0.1:4173/ws"
              placeholderTextColor={th.textTertiary}
              value={url}
              onChangeText={onUrlChange}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              textContentType="URL"
              returnKeyType="next"
            />
          </View>

          <View style={styles.field}>
            <Caption>Pairing code</Caption>
            <TextInput accessibilityLabel="Pairing code" value={code} onChangeText={(value) => { setCode(value); setToken(""); }}
              keyboardType="number-pad" maxLength={6} placeholder="000000"
              style={[styles.input, t.mono, { color: th.text, backgroundColor: th.surface }]} />
          </View>
          <View style={styles.field}>
            <Caption>Device token (optional)</Caption>
            <TextInput
              accessibilityLabel="Token"
              style={[styles.input, t.mono, { color: th.text, backgroundColor: th.surface }]}
              placeholder="Paste the bearer token"
              placeholderTextColor={th.textTertiary}
              value={token}
              onChangeText={(value) => { setToken(value); setCode(""); }}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              returnKeyType="go"
              onSubmitEditing={() => void connect()}
            />
          </View>

          {error ? <Text style={[t.body, { color: th.failed }]}>{error}</Text> : null}

          <Button title="Connect" variant="primary" onPress={() => void connect()} busy={busy} disabled={busy} />

          <Caption color={th.textTertiary}>
            On the host, choose Pair a device from the environment menu. Connect this phone to the same private network, then paste the invitation.
          </Caption>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: space.lg, gap: space.lg },
  field: { gap: space.xs },
  input: { minHeight: 44, paddingHorizontal: space.md, paddingVertical: 10, borderRadius: radius.md },
});
