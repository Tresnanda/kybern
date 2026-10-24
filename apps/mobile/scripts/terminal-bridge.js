const terminal = new Terminal({
  fontSize: 14,
  lineHeight: 1.3,
  cursorStyle: "bar",
  cursorInactiveStyle: "bar",
  screenReaderMode: true,
  fontFamily: "ui-monospace,Menlo,monospace",
  cursorBlink: false,
  scrollback: 3000,
  theme: {
    background: "#FFFFFF",
    foreground: "#1A1C1F",
    cursor: "#0969DA",
    selectionBackground: "#BBD8F9",
  },
});
const fit = new FitAddon.FitAddon();
terminal.loadAddon(fit);
terminal.open(document.getElementById("terminal"));
const send = (value) =>
  window.ReactNativeWebView.postMessage(JSON.stringify(value));
window.writeOutput = (data) => {
  terminal.write(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
  stale = true;
};
window.resetTerminal = () => {
  terminal.reset();
  stale = true;
  send({ type: "resize", cols: terminal.cols, rows: terminal.rows });
};
// The native input owns the software keyboard. WKWebView programmatic focus
// varies by iOS version; xterm retains hardware-key input and text selection.
terminal.textarea?.addEventListener("focus", () => {
  terminal.blur();
  send({ type: "focus" });
});
window.blurTerminal = () => terminal.blur();
// Scrollback search (no addon): scan the buffer's lines, select a hit and scroll it
// to the middle. A new query starts at the newest hit; `step` moves -1 up, +1 down.
let hits = [];
let at = -1;
let lastQuery = "";
let stale = false;
const scan = (q) => {
  hits = [];
  const buffer = terminal.buffer.active;
  for (let y = 0; y < buffer.length; y++) {
    const text = buffer.getLine(y)?.translateToString(true).toLowerCase() ?? "";
    for (let x = text.indexOf(q); x >= 0; x = text.indexOf(q, x + 1)) hits.push([y, x]);
  }
  stale = false;
};
window.findInTerminal = (query, step) => {
  const q = String(query || "").toLowerCase();
  if (!q) {
    hits = [];
    at = -1;
    lastQuery = "";
    terminal.clearSelection();
    send({ type: "search", index: 0, total: 0 });
    return;
  }
  if (q !== lastQuery) {
    lastQuery = q;
    scan(q);
    at = hits.length - 1;
  } else {
    if (stale) scan(q);
    if (hits.length) at = (Math.min(Math.max(at, 0), hits.length - 1) + step + hits.length) % hits.length;
  }
  if (at >= 0) {
    const [y, x] = hits[at];
    terminal.select(x, y, q.length);
    terminal.scrollToLine(Math.max(0, y - Math.floor(terminal.rows / 2)));
  } else terminal.clearSelection();
  send({ type: "search", index: at + 1, total: hits.length });
};
window.setTerminalTheme = ({ dark, ...theme }) => {
  terminal.options.theme = {
    ...theme,
    black: dark ? "#545454" : "#363A40",
    red: dark ? "#F78080" : "#AE3037",
    green: dark ? "#8BCD8F" : "#28763E",
    yellow: dark ? "#E6C579" : "#8C6719",
    blue: dark ? "#84B8FA" : "#306DC2",
    magenta: dark ? "#CE9EE8" : "#9951B1",
    cyan: dark ? "#7CCDD1" : "#207B82",
    white: dark ? "#DADADA" : "#616873",
    brightBlack: dark ? "#909090" : "#6B7280",
    brightRed: dark ? "#FFA1A1" : "#C43743",
    brightGreen: dark ? "#AAE2AD" : "#338347",
    brightYellow: dark ? "#F4D993" : "#916D1A",
    brightBlue: dark ? "#A5CCFF" : "#3979CC",
    brightMagenta: dark ? "#E3BEF7" : "#A45AB8",
    brightCyan: dark ? "#A1E0E3" : "#2A828A",
    brightWhite: dark ? "#FFFFFF" : "#343A43",
  };
  document.body.style.backgroundColor = theme.background;
  document.getElementById("terminal").style.backgroundColor = theme.background;
};
terminal.onData((data) => send({ type: "input", data }));
terminal.onResize((size) => send({ type: "resize", ...size }));
new ResizeObserver(() => fit.fit()).observe(
  document.getElementById("terminal"),
);
fit.fit();
send({ type: "ready", cols: terminal.cols, rows: terminal.rows });
