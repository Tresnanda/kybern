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
import { Field, T, Tap } from "./primitives";
import { radius, space, useTheme } from "./theme";

/**
 * Ask before an irreversible action, and only then. The title names the object
 * ("Delete “Project brief” forever?"); the button repeats the verb. iOS: a native
 * two-button alert. Android: the themed dialog with text buttons in a row.
 * Prefer Undo (a toast) for anything that can be restored.
 */
export function confirm({
  title,
  message,
  confirm: verb,
  destructive = true,
  onConfirm,
}: {
  title: string;
  message?: string;
  confirm: string;
  destructive?: boolean;
  onConfirm: () => void;
}) {
  Alert.alert(title, message, [
    { text: "Cancel", style: "cancel" },
    { text: verb, style: destructive ? "destructive" : "default", onPress: onConfirm },
  ]);
}

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
                contentContainerStyle={{ padding: space.xl, gap: space.md }}
              >
                <T variant="title" accessibilityRole="header">
                  {request.title}
                </T>
                {request.message ? (
                  <T variant="subhead" tone="secondary">{request.message}</T>
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
                <DialogButtons
                  buttons={request.buttons}
                  disabled={!open}
                  onSelect={select}
                />
              </ScrollView>
            </MorphingSurface>
          </View>
        </KeyboardAvoidingView>
      )}
    </Modal>
  );
}
/**
 * Material-style text buttons, end-aligned in one row: Cancel in `secondary`,
 * the action in `accent`, a destructive one in `negative`. More than two, or
 * labels too long to share a row, stack end-aligned.
 */
function DialogButtons({
  buttons,
  disabled,
  onSelect,
}: {
  buttons: DialogButton[];
  disabled: boolean;
  onSelect: (index: number) => void;
}) {
  const { colors } = useTheme();
  const stacked =
    buttons.length > 2 ||
    buttons.reduce((sum, b) => sum + (b.text ?? "OK").length, 0) > 28;
  return (
    <View
      style={{
        flexDirection: stacked ? "column" : "row",
        justifyContent: "flex-end",
        alignItems: stacked ? "flex-end" : "center",
        gap: stacked ? 0 : space.sm,
        marginTop: space.sm,
        marginEnd: -space.md,
      }}
    >
      {buttons.map((button, index) => {
        const color =
          button.style === "cancel"
            ? colors.secondary
            : button.style === "destructive"
              ? colors.negative
              : colors.accent;
        return (
          <Tap
            key={index}
            label={button.text ?? "OK"}
            disabled={disabled}
            feedback="highlight"
            onPress={() => onSelect(index)}
            style={{
              minHeight: 44,
              paddingHorizontal: space.md,
              borderRadius: radius.full,
              alignItems: "center",
            }}
          >
            <T
              variant="label"
              style={{
                color,
                fontWeight: button.style === "cancel" ? "500" : "600",
              }}
            >
              {button.text ?? "OK"}
            </T>
          </Tap>
        );
      })}
    </View>
  );
}

export function DialogHost() {
  const request = useSyncExternalStore(
    dialogQueue.subscribe,
    dialogQueue.getSnapshot,
  );
  return request ? <Dialog key={request.id} request={request} /> : null;
}
