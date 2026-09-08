import { router } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import { setDraft, useDraft } from "../src/state/draft";
import { useApp } from "../src/state/runtime";
import { Button, Empty, Field, Icon, Page, Row } from "../src/ui/primitives";
export default function ProjectPicker() {
  const app = useApp();
  const draft = useDraft();
  const [query, setQuery] = useState("");
  const projects = app.projects.filter((p) =>
    `${p.name} ${p.path}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <Page>
      <Field
        label="Search projects"
        placeholder="Name or folder"
        value={query}
        onChangeText={setQuery}
        autoCorrect={false}
      />
      <View style={{ marginVertical: 16 }}>
        <Button
          secondary
          icon="plus"
          onPress={() => router.push("/add-project")}
        >
          Add project
        </Button>
      </View>
      {projects.map((p) => (
        <Row
          key={p.id}
          title={p.name}
          detail={p.path}
          icon="folder"
          trailing={
            p.id === draft.projectId ? (
              <Icon name="checkmark" size={18} />
            ) : undefined
          }
          onPress={() => {
            setDraft({ projectId: p.id, baseBranch: "" });
            router.back();
          }}
        />
      ))}
      {!projects.length && (
        <Empty
          icon="folder"
          title={query ? "No matching projects" : "Add your first project"}
          detail="Choose a folder on your connected computer."
        />
      )}
    </Page>
  );
}
