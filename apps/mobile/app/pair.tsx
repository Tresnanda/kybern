import { Redirect, useLocalSearchParams } from "expo-router";
export default function Pair() {
  const params = useLocalSearchParams<{
    url?: string;
    code?: string;
    environment?: string;
    autoconnect?: string;
  }>();
  const { autoconnect, ...pairing } = params;
  const invitation = `kybern://pair?${new URLSearchParams(pairing as Record<string, string>)}`;
  // Development builds only: `autoconnect=1` pairs without the Connect tap, so a
  // test run can pair a real device it cannot tap (see apps/mobile/README.md).
  const auto = __DEV__ && autoconnect === "1" ? { autoconnect } : {};
  return <Redirect href={{ pathname: "/connect", params: { invitation, ...auto } }} />;
}
