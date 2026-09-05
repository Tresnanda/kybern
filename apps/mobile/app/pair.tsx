// `kybern://pair?url=…&code=…&environment=…` lands here; hand it to Connect.

import React from "react";
import { Redirect, useLocalSearchParams } from "expo-router";

export default function PairRoute() {
  const params = useLocalSearchParams<{ url?: string; code?: string; environment?: string }>();
  return <Redirect href={{ pathname: "/connect", params }} />;
}
