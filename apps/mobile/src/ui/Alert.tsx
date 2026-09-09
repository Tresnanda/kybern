import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import {
  Alert as NativeAlert,
  Modal,
  Platform,
  ScrollView,
  View,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  MorphingBackdrop,
  MorphingSurface,
} from "../components/liquid/MorphingSurface";
import {
  dialogQueue,
  type DialogButton,
  type DialogRequest,
} from "./dialogQueue";
import { Button, Field, T } from "./primitives";

export const Alert = {
  alert(
    title: string,
    message?: string,
    buttons?: DialogButton[],
    options?: { cancelable?: boolean; onDismiss?: () => void },
  ) {
    if (Platform.OS === "ios")
      return NativeAlert.alert(
        title,
        message,
        buttons?.map((button) => ({
          ...button,
          onPress: () => button.onPress?.(""),
        })),
        options,
      );
    dialogQueue.enqueue({
      title,
      message,
      buttons: buttons?.length ? buttons : [{ text: "OK" }],
      cancelable: options?.cancelable,
      onDismiss: options?.onDismiss,
    });
  },
  prompt(
    title: string,
    message?: string,
    callbackOrButtons?: ((value: string) => void) | DialogButton[],
    type?: "plain-text" | "secure-text",
    defaultValue?: string,
  ) {
    if (Platform.OS === "ios")
      return NativeAlert.prompt(
        title,
        message,
        Array.isArray(callbackOrButtons)
          ? callbackOrButtons.map((button) => ({
              ...button,
              onPress: (value?: string) => button.onPress?.(value ?? ""),
            }))
          : callbackOrButtons,
        type,
        defaultValue,
      );
    dialogQueue.enqueue({
      title,
      message,
      prompt: {
        defaultValue: defaultValue ?? "",
        secure: type === "secure-text",
      },
      buttons: Array.isArray(callbackOrButtons)
        ? callbackOrButtons
        : [
            { text: "Cancel", style: "cancel" },
            { text: "Save", onPress: callbackOrButtons },
          ],
    });
  },
};

function Dialog({ request }: { request: DialogRequest & { id: number } }) {
  const insets = useSafeAreaInsets();
  const [value, setValue] = useState(request.prompt?.defaultValue ?? "");
  const [open, setOpen] = useState(true);
  const [shown, setShown] = useState(false);
  const choice = useRef<{ index: number | null; value: string } | null>(null);
  const select = (index: number | null) => {
    if (choice.current) return;
    choice.current = { index, value };
    setOpen(false);
  };
  const dismiss = () => {
    const cancel = request.buttons.findIndex(
      (button) => button.style === "cancel",
    );
    if (cancel >= 0) select(cancel);
    else if (request.cancelable) select(null);
  };
  const finish = useCallback(() => {
    const selected = choice.current;
    if (selected)
      dialogQueue.finish(request.id, selected.index, selected.value);
  }, [request.id]);
  return (
    <Modal
      transparent
      visible
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      hardwareAccelerated
      onShow={() => setShown(true)}
      onRequestClose={dismiss}
    >
      {shown && (
        <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
          <View
            accessibilityViewIsModal
            onAccessibilityEscape={dismiss}
            style={{
              flex: 1,
              justifyContent: "center",
              paddingHorizontal: 24,
              paddingTop: insets.top + 24,
              paddingBottom: insets.bottom + 24,
            }}
          >
            <MorphingBackdrop open={open} onPress={dismiss} />
            <MorphingSurface
              open={open}
              onClosed={finish}
              style={{
                width: "100%",
                maxWidth: 420,
                maxHeight: "100%",
                alignSelf: "center",
              }}
            >
              <ScrollView
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={{ padding: 24, gap: 16 }}
              >
                <T variant="heading" accessibilityRole="header">
                  {request.title}
                </T>
                {request.message ? (
                  <T tone="secondary">{request.message}</T>
                ) : null}
                {request.prompt && (
                  <Field
                    label={request.title}
                    hideLabel
                    value={value}
                    onChangeText={setValue}
                    secureTextEntry={request.prompt.secure}
                    autoCorrect={false}
                  />
                )}
                <View style={{ gap: 8, marginTop: 8 }}>
                  {request.buttons.map((button, index) => (
                    <Button
                      key={index}
                      secondary={button.style === "cancel"}
                      danger={button.style === "destructive"}
                      disabled={!open}
                      onPress={() => select(index)}
                    >
                      {button.text ?? "OK"}
                    </Button>
                  ))}
                </View>
              </ScrollView>
            </MorphingSurface>
          </View>
        </KeyboardAvoidingView>
      )}
    </Modal>
  );
}
export function DialogHost() {
  const request = useSyncExternalStore(
    dialogQueue.subscribe,
    dialogQueue.getSnapshot,
  );
  return request ? <Dialog key={request.id} request={request} /> : null;
}
