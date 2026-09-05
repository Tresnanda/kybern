# Agent input, notifications, and response images

Reviewed September 5, 2026. This describes the desktop client and the native protocols used by Kybern. A protocol capability does not mean every model, tool, extension, or permission mode will emit it.

## Input requests

| Harness | Native request | Desktop behavior |
| --- | --- | --- |
| Claude Code | `can_use_tool` with `AskUserQuestion` | Multiple questions, single/multiple choices, custom answers. Returns answers keyed by question text inside the original tool input. |
| Claude Code | `request_user_dialog` / `resume_return` | Explicit choice to compact, retain history, or retain history and skip future prompts; preserves native completion/cancellation. Only this verified dialog kind is declared at initialization. |
| Claude Code | `ExitPlanMode` | Plan review with an explicit implementation action; no misleading “always allow” action. |
| Claude Code | MCP `elicitation` | Form fields or an explicit browser link, then accept/decline. |
| Codex | `item/tool/requestUserInput` | Questions and custom answers, including secret fields. Returns answers keyed by native question ID. Availability depends on the agent’s collaboration mode. |
| Codex | `mcpServer/elicitation/request` | Schema fields or URL interaction; preserves native request IDs and response shape. |
| OpenCode | `question.asked` | Single/multiple choices and custom answers when permitted. Replies with ordered answer arrays to `/question/{id}/reply`; decline uses `/reject`. Child-session requests are surfaced too. |
| pi | RPC `extension_ui_request` | Select, confirm, input, and multiline editor. Boolean false is an answer, distinct from cancellation. Provider timeouts withdraw requests. |
| OMP | RPC `extension_ui_request` | The same supported dialogs through its native RPC transport. This does not emulate arbitrary terminal extension widgets. |
| Cursor | ACP permission requests | Native permission choices remain supported. The currently integrated ACP interface does not expose a verified general question/form channel. Plain assistant questions remain text and are answered in the composer. |

Requests get a distinct `user_input_requested` event. Answers are validated before forwarding, and a failed write leaves the request available for retry. Provider withdrawal and turn completion/failure clear pending requests. Reload rebuilds pending state from the event history; daemon restart uses the existing interrupted-session recovery.

MCP forms cover primitive values, enums, enum arrays, required fields, and common bounds. Nested objects/arrays use a JSON input rather than pretending to have a complete schema-generated editor. Arbitrary JSON Schema keywords and arbitrary terminal/custom-extension UIs are not claimed as fully supported. Login flows remain in the browser or native CLI when that is what the harness exposes.

The CLI can answer with `kybern approvals answer <id> '<provider-native JSON response>'`; its interactive stream prompts for that JSON. Ordinary permission approvals cannot be used to silently submit a question.

## Notifications

Completion, failure, approval, and structured input requests share the desktop notification path. A visible thread in the focused app is quiet. Other threads produce an in-app notification with an Open thread action; a background app also sends a system notification when permission is granted. Old history is not replayed as notifications, and interrupted turns do not announce successful completion.

Settings includes an agent notification switch and a system permission/test action. On macOS, native UNUserNotificationCenter callbacks read/request actual OS authorization and report submission errors; the Tauri plugin alone reports granted unconditionally on that platform. Unbundled development executables report system notifications unavailable rather than borrowing Terminal’s identity. The native delegate also permits explicit test notifications while the app is focused. System delivery depends on OS permissions and notification settings. This is desktop delivery while the app is running, not a new push service for a closed app. In-app notification actions open the thread; native notification click-to-thread routing is not implemented here.

## Response images

Markdown images render as inline previews with an enlarged dialog, keyboard dismissal, loading, and retry states. HTTPS/HTTP and inline PNG/JPEG/GIF/WebP/AVIF images are supported. Local references are fetched with authentication from the owning daemon, relative to the thread working directory; absolute paths inside that directory also work. The daemon checks actual image signatures and limits files to 50 MB. Paths and symlinks outside the working directory are rejected. SVG and other active/unsupported formats are not rendered.

| Harness | Implemented image path |
| --- | --- |
| Claude Code | Tool-result image blocks plus Markdown references to generated files. Text responses do not imply a native image attachment. |
| Codex | Image-view/image-generation item payloads, nested tool image content, and Markdown image references. An image-view item shows an inspected image; it does not imply generation. |
| OpenCode | Assistant-authored file parts with an image MIME type, tool attachments, and Markdown. File parts wait for message metadata so echoed user uploads are not misattributed. |
| pi / OMP | Image-bearing tool content with native MIME/data fields, plus Markdown references. Actual tool/model configuration determines whether images are emitted. |
| Cursor | ACP assistant image blocks and tool content are retained; Markdown file references also render. ACP capability is not a guarantee that every Cursor model/tool produces images. |

Native image events and tool image payloads survive transcript reload. File references remain references: deleting or moving the file makes the image unavailable; they are not copied into permanent assets. Child-agent activity stays scoped to its own activity surface, and is not presented as the root assistant's answer. Remote URLs load directly without the daemon credential. Large base64 payloads are replaced by a short image marker in the expandable tool text.

## Source comparison

The source was inspected again after authorization, at these commits:

- [T3Code ChatMarkdown](https://github.com/pingdotgg/t3code/blob/2fa5ef4c7bf3aafabe98392d25be7eb86847ce8f/apps/web/src/components/ChatMarkdown.tsx) handles image rendering, including workspace references.
- [Synara ChatMarkdown](https://github.com/Emanuele-web04/synara/blob/562c5fea77cff1dacb29d5e6216ed94a05f1b6a1/apps/web/src/components/ChatMarkdown.tsx) distinguishes generated/local Markdown images and ordinary image URLs.
- [Synara notification logic](https://github.com/Emanuele-web04/synara/blob/562c5fea77cff1dacb29d5e6216ed94a05f1b6a1/apps/web/src/notifications/taskCompletion.logic.ts) separates completion and user-attention candidates and suppresses visible-thread alerts.
- [T3Code agent awareness](https://github.com/pingdotgg/t3code/blob/2fa5ef4c7bf3aafabe98392d25be7eb86847ce8f/packages/shared/src/agentAwareness.ts) distinguishes waiting for approval, waiting for input, completion, and failure.
- [T3Code Claude adapter](https://github.com/pingdotgg/t3code/blob/2fa5ef4c7bf3aafabe98392d25be7eb86847ce8f/apps/server/src/provider/Layers/ClaudeAdapter.ts) confirms text-keyed question answers and the newer resume dialog. Its wire transport was separately verified against official Claude Agent SDK 0.3.261 source and declarations.
- [T3Code Codex input tests](https://github.com/pingdotgg/t3code/blob/2fa5ef4c7bf3aafabe98392d25be7eb86847ce8f/apps/server/src/provider/Layers/CodexSessionRuntime.test.ts) require opening a URL elicitation before approval. Kybern now disables submission until its browser-open action succeeds; this does not claim the external browser flow itself has completed.
- [Synara Claude adapter](https://github.com/Emanuele-web04/synara/blob/562c5fea77cff1dacb29d5e6216ed94a05f1b6a1/apps/server/src/provider/Layers/ClaudeAdapter.ts) treats AskUserQuestion and plan review as dedicated interactions.
- [Synara pi adapter](https://github.com/Emanuele-web04/synara/blob/562c5fea77cff1dacb29d5e6216ed94a05f1b6a1/apps/server/src/provider/Layers/PiAdapter.ts) preserves image-bearing tool results and translates extension UI interactions.

Neither reference proves universal support for every harness/model/tool combination. The mappings above also come from Kybern’s drivers and the current native protocol documentation.

## Verification

New deterministic tests cover image extraction and author attribution, duplicate suppression, authenticated image HTTP access and symlink boundaries, Claude resume choices, Claude/Codex request-response payloads, OpenCode question HTTP endpoints, pi/OMP dialogs and timeouts, question validation, MCP form values, and desktop answer encoding. Protocol schema snapshots were reviewed and updated. The final deterministic runs passed 102 Rust tests and 62 desktop tests, plus formatting, Clippy, desktop lint/typecheck, and the production frontend build.

The native scratch app was exercised with a fake Claude process: an offscreen input notification opened the thread, blank submission showed validation, and a radio answer plus two checkbox answers reached the process in Claude’s native shape. Settings layout, mid-sentence slash suggestions, a moving drag card, and a new composer in an empty split pane were inspected in the native window.

The native scratch app also rendered an image-bearing Claude tool result and a relative Markdown image with spaces in its filename. The enlarged preview and missing-file retry state were inspected.

The workspace test suite passed after updating Codex to 0.153.4, including its real configured-model turn. Missing harness binaries skip their live entry. All real-model question/image permutations have not been exhaustively tested.

Release verification on September 5, 2026: the Apple Development-signed packaged app requested macOS notification permission; granting it changed Settings to “Send test notification.” macOS usernoted/NotificationCenter logs confirmed the test alert was delivered to notification history, presented as a banner, and played its sound. The native delegate therefore also works for explicit foreground tests. The app and DMG built successfully; public distribution notarization was not configured. Final checks passed the full Rust workspace suite (115 test entries, with absent harnesses skipping internally), 63 desktop tests, formatting, Clippy, typecheck, lint, and the production build. The final notification module’s desktop tests and Clippy were rerun after its delegate change.
