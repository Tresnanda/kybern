import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Platform, ScrollView, useWindowDimensions, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { parsePairingInvitation } from "../src/state/protocol";
import { addEnvironment, errorText, pairEnvironment } from "../src/state/runtime";
import { HeaderActions } from "../src/ui/ActionMenu";
import { Brand } from "../src/ui/Brand";
import { SectionFooter, SectionHeader } from "../src/ui/List";
import { Button, ErrorBanner, Field, T } from "../src/ui/primitives";
import { CONTENT_MAX_WIDTH, gutter, space, useTheme } from "../src/ui/theme";

// Pair this phone with Kybern on a computer: scan the invitation's QR code, or
// type its address and six-digit code. An access token is the fallback.
export default function Connect() {
  const { invitation, autoconnect } = useLocalSearchParams<{ invitation?: string; autoconnect?: string }>();
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [expected, setExpected] = useState<string>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!invitation) return;
    const parsed = parsePairingInvitation(invitation);
    if (parsed) {
      setAddress(parsed.url);
      setCode(parsed.code);
      setExpected(parsed.environmentId);
      setAdvanced(false);
      if (__DEV__ && autoconnect === "1") {
        setBusy(true);
        pairEnvironment(parsed.url, parsed.code, "", parsed.environmentId)
          .then(() => router.dismissTo("/"))
          .catch((e) => setError(errorText(e)))
          .finally(() => setBusy(false));
      }
    } else setError("This invitation is incomplete. Create a new one in Kybern on your computer.");
  }, [invitation, autoconnect]);

  const ready = !!address.trim() && (advanced ? !!token.trim() : /^\d{6}$/.test(code.trim()));
  async function submit() {
    if (!address.trim()) {
      setError("Enter the address shown on your computer.");
      return;
    }
    if (!advanced && !/^\d{6}$/.test(code.trim())) {
      setError("Enter the six-digit pairing code.");
      return;
    }
    setError("");
    setBusy(true);
    try {
      if (advanced) await addEnvironment({ url: address, token: token.trim() }, name);
      else await pairEnvironment(address, code, name, expected);
      router.dismissTo("/");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: colors.grouped }}>
      <Stack.Screen options={{ headerStyle: { backgroundColor: colors.grouped } }} />
      {Platform.OS === "ios" && (
        <>
          <Stack.Toolbar placement="left">
            <Stack.Toolbar.Button onPress={() => router.back()}>Cancel</Stack.Toolbar.Button>
          </Stack.Toolbar>
          <HeaderActions buttons={[{ title: "Connect", prominent: true, disabled: !ready || busy, onPress: () => void submit() }]} />
        </>
      )}
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          paddingHorizontal: gutter(width),
          paddingTop: space.lg,
          paddingBottom: insets.bottom + space["2xl"],
          maxWidth: CONTENT_MAX_WIDTH,
          width: "100%",
          alignSelf: "center",
        }}
      >
        <View style={{ alignItems: "center", gap: space.md, paddingBottom: space.xl }}>
          <Brand size={44} />
          <T tone="secondary" style={{ textAlign: "center", maxWidth: 340 }}>
            Open Kybern on your computer, choose its environment menu, then create a pairing invitation.
          </T>
        </View>
        <Button icon="qrcode.viewfinder" onPress={() => router.push("/scan-pairing")}>
          Scan QR code
        </Button>

        <SectionHeader title={advanced ? "Or enter an access token" : "Or enter the code"} />
        <View style={{ gap: space.lg }}>
          <Field
            label="Computer address"
            placeholder="100.64.0.2:4173"
            value={address}
            onChangeText={setAddress}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            textContentType="URL"
          />
          {advanced ? (
            <Field
              label="Access token"
              value={token}
              onChangeText={setToken}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="Paste your access token"
            />
          ) : (
            <Field
              label="Pairing code"
              variant="code"
              placeholder="000000"
              value={code}
              onChangeText={(text) => setCode(text.replace(/\D/g, ""))}
              maxLength={6}
            />
          )}
          <Field label="Computer name (optional)" placeholder="MacBook Pro" value={name} onChangeText={setName} />
        </View>
        <SectionFooter>
          {"Use the address from your pairing invitation. Away from home, keep both devices on the same Tailscale network."}
        </SectionFooter>
        <ErrorBanner error={error} />
        {Platform.OS !== "ios" && (
          <View style={{ paddingTop: space.lg }}>
            <Button role="prominent" busy={busy} disabled={!ready} onPress={() => void submit()}>
              Connect
            </Button>
          </View>
        )}
        <View style={{ alignItems: "center", paddingTop: space.lg }}>
          <Button
            role="plain"
            size="medium"
            onPress={() => {
              setAdvanced(!advanced);
              setError("");
            }}
          >
            {advanced ? "Use a pairing code instead" : "Use an access token instead"}
          </Button>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
