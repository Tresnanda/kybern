// Full-screen Preview for a thread (parity P2-1). On wide layouts the same pane lives in the
// inspector's Preview tab.
import { Stack, useLocalSearchParams } from "expo-router";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PreviewPane } from "../src/features/Preview";
import { useTheme } from "../src/ui/theme";

export default function PreviewScreen() {
  const { threadId = "", target } = useLocalSearchParams<{ threadId: string; target?: string }>();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: colors.background, paddingBottom: insets.bottom }}>
      <Stack.Screen options={{ title: "Preview" }} />
      <PreviewPane threadId={threadId} initialTarget={target} />
    </KeyboardAvoidingView>
  );
}
