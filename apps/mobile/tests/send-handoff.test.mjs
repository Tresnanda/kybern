import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as geometry from "../src/components/liquid/sendGeometry.ts";

// Execute the actual Flight component with controllable UI/RN schedulers.
// Native measurement is the input; RN completion deliberately stays queued.
const source = readFileSync(
  new URL("../src/components/liquid/SendTransition.tsx", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(`${source}\nexport { Flight };`, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
  },
}).outputText;

function mountFlight() {
  const effects = [];
  const styles = [];
  const queued = [];
  let frame;
  let target = { pageX: 240, pageY: 300 };
  let completions = 0;
  const shared = (initial) => {
    let value = initial;
    return {
      get: () => value,
      set: (next) => {
        value = next;
      },
    };
  };
  const modules = {
    react: {
      createContext: () => ({}),
      useEffect: (effect) => effects.push(effect),
    },
    "react/jsx-runtime": { jsx: () => null, jsxs: () => null },
    "react-native": {
      Keyboard: { dismiss() {} },
      StyleSheet: { absoluteFill: {} },
    },
    "react-native-keyboard-controller": {
      useReanimatedKeyboardAnimation: () => ({ height: shared(0) }),
    },
    "react-native-reanimated": {
      __esModule: true,
      default: { View: "View" },
      useSharedValue: shared,
      useDerivedValue: (get) => ({ get }),
      useAnimatedStyle: (get) => {
        styles.push(get);
        return {};
      },
      useFrameCallback: (callback) => {
        frame = callback;
      },
      measure: () => target,
      withTiming: (value, _config, done) => {
        done?.(true);
        return value;
      },
      Easing: { bezier: () => null },
    },
    "react-native-worklets": {
      scheduleOnRN: (fn, ...args) => queued.push(() => fn(...args)),
    },
    "../../features/MessagePart": {},
    "../../state/sendTransition": {},
    "../../ui/theme": { useTheme: () => ({ colors: { raised: "#eee" } }) },
    "./sendGeometry": geometry,
  };
  const exports = {};
  runInNewContext(compiled, {
    exports,
    require: (id) => {
      assert.ok(id in modules, `Unexpected dependency: ${id}`);
      return modules[id];
    },
  });
  exports.Flight({
    flight: {
      id: 1,
      keyboardAtSend: -300,
      dismissKeyboard: true,
      message: { parts: [] },
      sources: {},
      destination: {
        bubble: { x: 240, y: 300, width: 100, height: 50 },
        bubbleRef: {},
        parts: {},
      },
    },
    origin: { x: 0, y: 0 },
    finish: () => {
      completions++;
    },
  });
  effects.forEach((effect) => effect());
  return {
    frame: () => frame(),
    move: (x, y) => {
      target = { pageX: x, pageY: y };
    },
    offset: () => styles[0]().transform.map((entry) => Object.values(entry)[0]),
    flush: () => {
      queued.splice(0).forEach((fn) => fn());
    },
    get queued() {
      return queued.length;
    },
    get completions() {
      return completions;
    },
  };
}

test("landing keeps tracking late keyboard/list movement until React removes the overlay", () => {
  const flight = mountFlight();
  flight.frame();
  flight.frame();
  assert.equal(flight.queued, 1);
  assert.equal(flight.completions, 0); // RN thread is busy: overlay is still visible.
  flight.move(240, 318);
  flight.frame();
  assert.equal(
    flight.offset()[1],
    18,
    "visible overlay must not freeze before the real bubble replaces it",
  );
  flight.move(244, 324);
  flight.frame();
  assert.equal(flight.offset()[0], 4);
  assert.equal(flight.offset()[1], 24);
  assert.equal(
    flight.queued,
    1,
    "tracking must not enqueue duplicate completion callbacks",
  );
  flight.flush();
  assert.equal(flight.completions, 1);
});

test("destination offsets are correct before the completion handoff", () => {
  const flight = mountFlight();
  flight.move(247, 312);
  flight.frame();
  assert.equal(flight.offset()[0], 7);
  assert.equal(flight.offset()[1], 12);
  assert.equal(flight.queued, 0);
});
