import React from "react";
import { ActivityIndicator } from "react-native";
import { Redirect } from "expo-router";
import { useConnection } from "@/connection/ConnectionContext";
import { Screen } from "@/ui/Screen";
import { useTheme } from "@/ui/theme";

export default function Index() {
  const { ready, endpoint } = useConnection();
  const th = useTheme();
  if (!ready) {
    return (
      <Screen style={{ alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={th.textSecondary} />
      </Screen>
    );
  }
  return <Redirect href={endpoint ? "/threads" : "/connect"} />;
}
