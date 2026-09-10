import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

// Run the real menu with independent animation, React, and native dismissal
// queues. Finishing the animation must not launch a picker from the old modal.
const source = readFileSync(
  process.env.KYBERN_MENU_TEST_SOURCE ??
    new URL("../src/components/liquid/MorphingMenu.tsx", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
  },
}).outputText;

function mountMenu(platform, reduced, closingMotion) {
  const slots = [], effects = [], animations = [], rn = [];
  let cursor = 0, open = true, launches = 0;
  const slot = (create) => {
    const index = cursor++;
    return slots[index] ??= create();
  };
  const same = (a, b) => a?.length === b.length && b.every((v, i) => Object.is(v, a[i]));
  const callback = (fn, deps) => {
    const state = slot(() => ({}));
    if (!same(state.deps, deps)) Object.assign(state, { value: fn, deps });
    return state.value;
  };
  const jsx = (type, props) => ({ type, props });
  const shared = (initial) => slot(() => ({
    value: initial,
    get() { return this.value; },
    set(value) { this.value = value; },
  }));
  const animate = (value, _options, done) => {
    if (done) animations.push(done);
    return value;
  };
  const modules = {
    react: {
      useState: (initial) => {
        const state = slot(() => ({ value: initial }));
        return [state.value, (value) => { state.value = value; }];
      },
      useRef: (current) => slot(() => ({ current })),
      useCallback: callback,
      useEffect: (effect, deps) => {
        const state = slot(() => ({}));
        if (!same(state.deps, deps)) { state.deps = deps; effects.push(effect); }
      },
    },
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react-native": {
      Platform: { OS: platform }, Modal: "Modal", View: "View",
      ScrollView: "ScrollView", Pressable: "Pressable",
      StyleSheet: { absoluteFill: {} },
      useWindowDimensions: () => ({ width: 834, height: 1194 }),
    },
    "react-native-reanimated": {
      __esModule: true, default: { View: "AnimatedView" },
      useSharedValue: shared, useDerivedValue: (get) => ({ get }),
      useAnimatedStyle: () => ({}), useFrameCallback() {},
      useReducedMotion: () => reduced,
      withTiming: animate, withSpring: animate,
      Easing: { bezier: () => null }, ReduceMotion: { System: "system", Never: "never" },
    },
    "react-native-worklets": { scheduleOnRN: (fn) => rn.push(fn) },
    "react-native-safe-area-context": { useSafeAreaInsets: () => ({ top: 24, bottom: 20 }) },
    "@react-native-masked-view/masked-view": { default: "MaskedView" },
    "expo-blur": { BlurView: "BlurView" },
    "../../ui/primitives": { Icon: "Icon" },
    "../../ui/theme": { useTheme: () => ({ colors: {}, dark: true }) },
    "./motion": { MASS: {}, SIZE: {} },
  };
  const exports = {};
  runInNewContext(compiled, { exports, require: (id) => {
    assert.ok(id in modules, `Unexpected dependency: ${id}`);
    return modules[id];
  } });
  const onClosed = () => { launches++; };
  const render = () => {
    cursor = 0;
    const tree = exports.MorphingMenu({
      origin: { x: 24, y: 900, width: 44, height: 44 },
      open, onClose() {}, onClosed, closingMotion, children: "Files",
    });
    effects.splice(0).forEach((fn) => fn());
    return tree;
  };
  const find = (node, type) => {
    if (!node || typeof node !== "object") return;
    if (node.type === type) return node;
    return [node.props?.children].flat().map((child) => find(child, type)).find(Boolean);
  };
  let modal = render();
  modal.props.onShow();
  find(modal, "ScrollView").props.onContentSizeChange(224, 260);
  render();
  animations.splice(0).forEach((done) => done(true));
  rn.splice(0).forEach((fn) => fn());
  return {
    close() { open = false; render(); },
    finishAnimation() {
      animations.splice(0).forEach((done) => done(true));
      rn.splice(0).forEach((fn) => fn());
      modal = render();
    },
    get modal() { return modal; },
    get launches() { return launches; },
  };
}

for (const reduced of [false, true]) {
  for (const motion of ["attachment", "spring"]) {
    test(`iOS ${motion} menu waits for native dismissal (reduced motion: ${reduced})`, () => {
      const menu = mountMenu("ios", reduced, motion);
      menu.close();
      assert.equal(menu.launches, 0);
      menu.finishAnimation();
      assert.equal(menu.launches, 0, "picker must wait until UIKit removes the menu");
      assert.equal(menu.modal.props.visible, false);
      menu.modal.props.onDismiss();
      assert.equal(menu.launches, 1);
      menu.modal.props.onDismiss();
      assert.equal(menu.launches, 1, "a queued action must only run once");
    });
  }
  test(`Android closes after the animation without an iOS event (reduced motion: ${reduced})`, () => {
    const menu = mountMenu("android", reduced, "attachment");
    menu.close();
    assert.equal(menu.launches, 0);
    menu.finishAnimation();
    assert.equal(menu.launches, 1);
  });
}
