// Pairing. Paste the invitation from the desktop app, or type the address and
// the six-digit code. A device token is the escape hatch.

import React, { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { FadeIn, FadeInDown, LinearTransition } from "react-native-reanimated";
import { useConnection } from "@/connection/ConnectionContext";
import { endpointFromForm, parsePairingUrl, redeemPairing } from "@/connection/pairing";
import { Button } from "@/ui/Button";
import { Field } from "@/ui/Field";
import { Glass } from "@/ui/Glass";
import { Icon } from "@/ui/Icon";
import { Screen, Txt } from "@/ui/Screen";
import { GUTTER, radius, space, useTheme } from "@/ui/theme";

export default function ConnectScreen() {
  const th = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ url?: string; token?: string; code?: string; environment?: string }>();
  const { connectTo, endpoint } = useConnection();
  const [url, setUrl] = useState(params.url ?? endpoint?.url ?? "");
  const [token, setToken] = useState(params.token ?? "");
  const [code, setCode] = useState(params.code ?? "");
  const [useToken, setUseToken] = useState(Boolean(params.token));
  const [environmentId, setEnvironmentId] = useState(params.environment);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onUrlChange = (text: string) => {
    const pairing = parsePairingUrl(text);
    if (pairing) {
      setUrl(pairing.url);
      setToken("");
      setCode(pairing.code);
      setUseToken(false);
      setEnvironmentId(pairing.environmentId);
    } else {
      setUrl(text);
      setEnvironmentId(undefined);
    }
  };

  const connect = async () => {
    const ep = useToken ? endpointFromForm(url, token) : null;
    if (!url.trim()) {
      setError("Enter the address of the machine running kybernd.");
      return;
    }
    if (!useToken && code.trim().length < 6) {
      setError("Enter the six-digit code from the desktop app.");
      return;
    }
    if (useToken && !ep) {
      setError("Paste the device token.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await connectTo(useToken ? ep! : await redeemPairing(url, code.trim(), environmentId));
      router.replace("/threads");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <KeyboardAwareScrollView bottomOffset={32} contentContainerStyle={[styles.content, { paddingTop: insets.top + space.xxl, paddingBottom: insets.bottom + space.xl }]} keyboardShouldPersistTaps="handled">
        <Animated.View entering={FadeInDown.duration(320)} style={styles.hero}>
          <Glass radius={radius.xl} style={styles.mark}>
            <Icon name="signal" size={30} color={th.text} weight="semibold" />
          </Glass>
          <Txt variant="largeTitle" style={{ letterSpacing: -0.4 }}>
            Connect to your machine
          </Txt>
          <Txt variant="body" tone="secondary" style={{ maxWidth: 340 }}>
            Watch agents work, approve what they ask for, and start threads from anywhere on your network.
          </Txt>
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(60).duration(320)} layout={LinearTransition.springify().damping(20)} style={styles.form}>
          <Field
            label="Machine address"
            mono
            placeholder="ws://100.64.0.1:4173/ws"
            hint="A host, host:port, or a pairing link. Paste the invitation here."
            value={url}
            onChangeText={onUrlChange}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            textContentType="URL"
            returnKeyType="next"
          />
          {useToken ? (
            <Animated.View entering={FadeIn.duration(160)}>
              <Field
                label="Device token"
                mono
                placeholder="Paste the bearer token"
                value={token}
                onChangeText={setToken}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                returnKeyType="go"
                onSubmitEditing={() => void connect()}
              />
            </Animated.View>
          ) : (
            <Animated.View entering={FadeIn.duration(160)}>
              <Field
                label="Pairing code"
                mono
                placeholder="000000"
                hint="On the desktop app, choose Pair a device from the environment menu."
                value={code}
                onChangeText={setCode}
                keyboardType="number-pad"
                textContentType="oneTimeCode"
                maxLength={6}
                returnKeyType="go"
                onSubmitEditing={() => void connect()}
                style={{ letterSpacing: 6, fontSize: 22 }}
              />
            </Animated.View>
          )}

          {error ? (
            <Animated.View entering={FadeIn.duration(160)}>
              <Txt variant="footnote" color={th.failed}>
                {error}
              </Txt>
            </Animated.View>
          ) : null}

          <Button title="Connect" variant="ink" size="large" haptic="medium" busy={busy} disabled={busy} onPress={() => void connect()} />
          <Txt
            variant="footnote"
            tone="secondary"
            onPress={() => {
              setUseToken((v) => !v);
              setError(null);
            }}
            suppressHighlighting
            style={styles.switch}
          >
            {useToken ? "Use a pairing code instead" : "Use a device token instead"}
          </Txt>
        </Animated.View>

        <View style={{ flex: 1 }} />
        <Txt variant="footnote" tone="tertiary" style={{ textAlign: "center" }}>
          Same LAN or Tailscale. Traffic stays on your private network.
        </Txt>
      </KeyboardAwareScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { flexGrow: 1, paddingHorizontal: GUTTER, gap: space.xxl },
  hero: { gap: space.md },
  mark: { width: 64, height: 64, alignItems: "center", justifyContent: "center", marginBottom: space.sm },
  form: { gap: space.lg },
  switch: { textAlign: "center", paddingVertical: space.sm },
});
