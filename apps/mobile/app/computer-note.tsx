// Edit what agents learned about one app. Kept short: it reaches later prompts.
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import { saveComputerNote, useComputerUse } from "../src/state/computerUse";
import { errorText } from "../src/state/runtime";
import { confirm } from "../src/ui/Alert";
import { HeaderActions } from "../src/ui/ActionMenu";
import { SectionFooter } from "../src/ui/List";
import { Button, Empty, ErrorBanner, Field, Page } from "../src/ui/primitives";
import { space } from "../src/ui/theme";

const MAX = 1500;

export default function ComputerNoteScreen() {
  const { bundleId } = useLocalSearchParams<{ bundleId: string }>();
  const { notes } = useComputerUse();
  const note = notes?.find((n) => n.bundle_id === bundleId);
  const [text, setText] = useState(note?.text ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async (value: string) => {
    if (!note) return;
    setBusy(true);
    setError("");
    try {
      await saveComputerNote(note, value);
      router.back();
    } catch (e) {
      setError(`Unable to save the note. ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };
  if (!note)
    return (
      <Page grouped>
        <Empty title="Note not found" detail="It may have been deleted on your computer." />
      </Page>
    );
  return (
    <Page grouped>
      <Stack.Screen options={{ title: note.app }} />
      <HeaderActions
        buttons={[
          {
            title: "Save",
            prominent: true,
            disabled: busy || text.trim() === note.text.trim() || text.length > MAX,
            onPress: () => void save(text.trim()),
          },
        ]}
      />
      <ErrorBanner error={error} />
      <Field
        label="Note"
        hideLabel
        multiline
        value={text}
        onChangeText={setText}
        style={{ minHeight: 200, textAlignVertical: "top" }}
        error={text.length > MAX ? `Keep it under ${MAX} characters.` : undefined}
      />
      <SectionFooter>{`${text.length} of ${MAX} characters. Agents read this as a hint the first time a session uses ${note.app}.`}</SectionFooter>
      <View style={{ marginTop: space["2xl"] }}>
        <Button
          role="destructive"
          onPress={() =>
            confirm({
              title: `Delete the note for ${note.app}?`,
              message: "Agents start over with this app.",
              confirm: "Delete note",
              onConfirm: () => void save(""),
            })
          }
        >
          Delete note
        </Button>
      </View>
    </Page>
  );
}
