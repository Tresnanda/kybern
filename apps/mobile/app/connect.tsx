import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { parsePairingInvitation } from "../src/state/protocol";
import {
  addEnvironment,
  errorText,
  pairEnvironment,
} from "../src/state/runtime";
import { Brand } from "../src/ui/Brand";
import {
  Button,
  ErrorBanner,
  Field,
  IconButton,
  Page,
  T,
  Tap,
} from "../src/ui/primitives";

export default function Connect() {
  const { invitation } = useLocalSearchParams<{ invitation?: string }>();
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [expected, setExpected] = useState<string>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (invitation) {
      const parsed = parsePairingInvitation(invitation);
      if (parsed) {
        setAddress(parsed.url);
        setCode(parsed.code);
        setExpected(parsed.environmentId);
      } else
        setError(
          "This invitation is incomplete. Create a new one in Kybern on your computer.",
        );
    }
  }, [invitation]);
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
      if (advanced)
        await addEnvironment({ url: address, token: token.trim() }, name);
      else await pairEnvironment(address, code, name, expected);
      router.dismissTo("/");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Page>
      <Stack.Screen
        options={{
          headerRight: () => (
            <IconButton
              name="xmark"
              label="Close connection setup"
              onPress={() => router.back()}
            />
          ),
        }}
      />
      <View style={{ paddingTop: 22, gap: 16, paddingBottom: 32 }}>
        <Brand size={45} />
        <T variant="title">Connect your computer.</T>
        <T tone="secondary">
          Open Kybern on your computer, choose its environment menu, then create
          a pairing invitation.
        </T>
      </View>
      <View style={{ gap: 22 }}>
        <Button
          secondary
          icon="qrcode.viewfinder"
          onPress={() => router.push("/scan-pairing")}
        >
          Scan QR code
        </Button>
        <Field
          label="Computer address"
          placeholder="100.64.0.2:4173"
          value={address}
          onChangeText={setAddress}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
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
            placeholder="000000"
            value={code}
            onChangeText={setCode}
            keyboardType="number-pad"
            maxLength={6}
            style={{ fontSize: 24, letterSpacing: 6 }}
          />
        )}
        <Field
          label="Computer name (optional)"
          placeholder="MacBook Pro"
          value={name}
          onChangeText={setName}
        />
        <ErrorBanner error={error} />
        <Button
          onPress={() => void submit()}
          busy={busy}
          disabled={advanced && !token.trim()}
        >
          Connect computer
        </Button>
        <T variant="caption" tone="secondary">
          Use the address from your pairing invitation. For connections away
          from home, keep both devices on the same Tailscale network.
        </T>
        <Tap
          label={advanced ? "Use a pairing code" : "Use an access token"}
          onPress={() => {
            setAdvanced(!advanced);
            setError("");
          }}
        >
          <T variant="caption" tone="secondary">
            {advanced ? "Use a pairing code" : "Use an access token instead"}
          </T>
        </Tap>
      </View>
    </Page>
  );
}
