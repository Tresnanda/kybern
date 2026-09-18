# Questions, approval cards, and macOS checks — 2026-09-18

## Behavior

Async questions and native harness question requests now show one question at a
time. Previous/Next preserve choices and custom drafts. The final review lists
answers with individual edit actions; only Send answers submits. Secret answers
remain masked in review. Decline, busy state, retry errors, native response
encoding, multiple choice, and custom answers retain their existing semantics.
MCP schema/URL requests and native UI confirmation/editor requests keep their
specialized forms.

Approval cards use a compact primary/decline footer. Session permission and
Cancel turn remain in More approval options; numeric shortcuts and callback
identities are unchanged. Components use existing Kybern icons, buttons, menu
materials, and the shared composer frame. The interaction reference was
[BeUI approval cards](https://beui.dev/components/agents/approval-card).

## Verification

Native WKWebView fixtures run at tauri://localhost under the production CSP on
Apple Silicon macOS. `questions` passed multiline, focus, explicit send, busy,
retry, native payload, secret masking, dark/light, RTL, 280–920px widths, larger
text, step navigation, draft retention, editable review, and bounded scrolling.
`composer-stack` passed 60 layout samples and direct approval callback checks,
including the session action in the overflow menu and connector Allow once.
Screenshots were inspected in the original workspace artifact folder.

## Issue #34

The driver cleanup check now synchronizes with an actual started descendant and
checks its disappearance instead of relying on an 80ms/300ms timing race. A
cleanup guard prevents a failed assertion from leaving test processes alive.
All 117 driver library tests passed; the focused all-six-driver lifecycle test
also passed five consecutive repeats.

The history-retention fixture gates its mock response while initial geometry
settles, captures the reading anchor, then releases the prepend and waits for
settled geometry again. It still asserts the same DOM node, selection, focus,
follow behavior, and the original <2px anchor limit. There is no production
virtualizer change or relaxed threshold. Default width passed; eight 480px runs
at offsets 100, 200, 400, and 1000 (two each) passed with 0–0.75px shifts.
