import { Redirect, useLocalSearchParams } from "expo-router";
export default function Pair() {
  const params = useLocalSearchParams<{
    url?: string;
    code?: string;
    environment?: string;
  }>();
  const invitation = `kybern://pair?${new URLSearchParams(params as Record<string, string>)}`;
  return <Redirect href={{ pathname: "/connect", params: { invitation } }} />;
}
