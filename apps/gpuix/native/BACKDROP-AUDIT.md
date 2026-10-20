# Desktop backdrop audit (round 7)

Audited `rg -n "backdrop" apps/desktop/src` against the merged desktop reference.
These are CSS **backdrop** filters, distinct from entrance `filter: blur(...)`
which blurs a surface itself. No whole-window vibrancy is changed by this package.

| Reference | Exact filter | Activation / integration |
| --- | --- | --- |
| `components/kit/chat/composerPickerStyles.ts` ordinary menu/popover/select/tooltip pseudo-element | Tailwind `backdrop-blur-2xl` (40px), `backdrop-saturate-150` (150%) | A single layer behind popup fill. Full translucency overrides it with 16px/125%, disables the pseudo-element. |
| `kit.css` `.composer-picker-menu-surface` | `var(--app-composer-picker-backdrop-filter, blur(32px))` | Theme sets 32px for translucent material, none for opaque; full translucency sets 16px/125%. |
| `kit.css` `.composer-command-menu-surface` | command token, picker token fallback, then none | `kybern.css` sets command filter to none. Slash/mention list remains a dense fill. |
| `components/kit/dialog.tsx`, alert dialogs/sheets | None by default | `kybern.css` full-translucency selector adds `blur(16px) saturate(125%)` and 78% popover fill. Patch routes through `PopupLayer` once. Dim backdrop has no filter. |
| `components/kit/command.tsx` palette | No backdrop filter | Its entrance `blur` is ordinary filter, not backdrop. The palette is excluded from the full-translucency popup selector. Patch preserves this. |
| `kybern.css` `.thread-drop-target` | `blur(18px) saturate(125%)` | Only mounted during drag. Patch applies to the highlight. |
| `kybern.css` `.thread-drop-label` | `blur(18px) saturate(140%)` | Small label within the drop target. Patch applies separately as in reference. |
| `kybern.css` `.computer-live-scrim` | `blur(10px)` | 56px, or 76px when tall. Mask fades from transparent top to black at midpoint. Native `fadeTop: .5` filters the same progression. |
| `kybern.css` `.computer-live-controls` | `blur(12px)` | Revealed on hover/focus; patch enables only when hovered. |
| `kit.css` `.preview-pip__header` | `blur(12px) saturate(140%)` | Hover/focus/drag, always shown for coarse pointer. Reduced transparency/contrast disables. Current native preview is a metadata card with a visible header; patch applies only to that header. |
| `kit.css` `.visual-reply__open` | `blur(12px) saturate(140%)` | Only revealed hover/focus or coarse pointer. Not one of this round's app integration targets. |
| `kit.css` `.local-image-preview__download`, `.local-image-error__action` | `blur(8px)` | Image actions; listed for later app integration. |
| `kit.css` `.chat-generated-image__overlay-pill` | `blur(8px)` | Image overlay action; listed for later app integration. |
| `notes.css` `.note-toolbar` | `blur(20px) saturate(160%)` | Reduced transparency disables; listed for later app integration. |
| `views/Transcript.tsx` scroll-to-bottom button | Tailwind `backdrop-blur-md` (12px) | Opaque elevated fill in normal theme; not changed by this round. |
| `kit.css` frame/sidebar surfaces | `var(--app-sidebar-backdrop-filter, none)` | Legacy CSS declares 8px/135%; `theme.logic.ts` currently sets none because native vibrancy already blurs behind the window. No additional filter added. |
| `kit.css` settings surface | `var(--app-settings-backdrop-filter, none)` | Current theme and full translucency both set none. No additional filter added. |
| `kit.css` composer shell/stack pseudo-elements | `var(--composer-glass-filter)` | Full translucency 16px/125%; opaque/reduced-transparency/contrast none. Outside this round's floating-surface patch. |

Full-translucency reduced-transparency / increased-contrast override sets popup
fills opaque and `--app-glass-backdrop-filter: none`. Native integration reads OS
accessibility settings at launch (same model as its existing reduced-motion
setting) and reacts to app translucency preference changes. Live OS accessibility
changes require relaunch; this patch does not claim an OS preference observer.

## Links

`kit.css:847`: transcript anchors use token link foreground, no underline; hover
and focus-visible use active link foreground plus underline, from-font thickness,
0.18em offset. `notes.css:1234`: note anchors use the same foreground and always
underline; underline color is 35% of link color until hover, then currentColor.
The new native API supplies color, none/always/hover underline, and weight.
The patch uses hover for transcript and always for notes. Native underline is
1 logical pixel, and keyboard focus styling, separate active link color, and
notes' 35% underline color are not implemented by these three requested controls.
Click/selection byte ranges are unchanged; no invisible replacement links.
